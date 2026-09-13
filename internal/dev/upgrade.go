package dev

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/rpctransport"

	"clankerbox/internal/host"
	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

type bundleUpgrade struct {
	FromDigest string `json:"from_digest"`
	ToDigest   string `json:"to_digest"`
	ToPath     string `json:"to_path"`
}

// Upgrades replace service code only. Native runtime/image/profile content pins
// must remain identical, so every existing VM and accepted journal keeps its
// meaning. The private service configuration is the durable previous pin even
// if a locally supplied old bundle was accidentally overwritten.
func (e *environment) compatibleUpgrade() error {
	if _, err := os.Lstat(e.HostRoot); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if err := e.validateHostRoot(); err != nil {
		return err
	}
	raw, err := statefs.ReadPrivate(filepath.Join(e.HostRoot, "service.json"))
	if err != nil {
		return err
	}
	var old host.Config
	if err = json.Unmarshal(raw, &old); err != nil {
		return err
	}
	next := e.hostConfig()
	if old.Root != next.Root || old.HostID != next.HostID || old.HostOS != next.HostOS || old.RuntimeDigest == "" ||
		old.RuntimeDigest != next.RuntimeDigest ||
		len(old.Profiles) != 1 ||
		len(next.Profiles) != 1 {
		return errors.New(
			"bundle upgrade changes retained runtime identity; preserve this environment and create another",
		)
	}
	if old.Profiles[0].ImageDigest == "" || !model.SameProfile(old.Profiles[0], next.Profiles[0]) {
		return errors.New(
			"bundle upgrade changes retained image/profile content; preserve this environment and create another",
		)
	}
	return nil
}
func (e *environment) applyUpgrade(ctx context.Context) error {
	intent := bundleUpgrade{FromDigest: e.BundleDigest, ToDigest: e.bundle.digest, ToPath: e.bundle.manifest}
	if err := jsonWrite(e.dir, upgradeManifest, intent); err != nil {
		return err
	}
	if err := e.upgradeService(ctx); err != nil {
		return err
	}

	e.BundlePath = e.bundle.manifest
	e.BundleDigest = e.bundle.digest
	e.ProfileID = e.bundle.ProfileID
	if err := jsonWrite(e.dir, environmentManifest, e); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(e.StateDir, upgradeManifest)); err != nil {
		return err
	}
	e.upgrade = false
	return nil
}

// Reading IDs from the local owned journal discovers accepted work; status and
// completion are obtained from the ordinary authenticated host API.
func (e *environment) drainHost(ctx context.Context) error {
	path := filepath.Join(e.HostRoot, "host.db")
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("host journal is not a regular owned file")
	}
	uri := url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro"}
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	rows, err := db.QueryContext(ctx, "SELECT id FROM operations ORDER BY rowid")
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return err
		}
		ids = append(ids, id)
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	hc, origin, err := rpctransport.Client(e.hostConfig().Listen, rpctransport.Credentials{}, "")
	if err != nil {
		return err
	}
	defer hc.CloseIdleConnections()
	rpc := clankerboxv1connect.NewHostServiceClient(hc, origin)
	bounded, cancel := context.WithTimeout(ctx, upgradeDrainTimeout)
	defer cancel()
	for _, id := range ids {
		if err = waitHostSettled(bounded, rpc, id); err != nil {
			return err
		}
	}
	return nil
}
func waitHostSettled(ctx context.Context, rpc clankerboxv1connect.HostServiceClient, id string) error {
	for {
		response, err := rpc.GetHostOperation(ctx, connect.NewRequest(&v1.GetHostOperationRequest{OperationId: id}))
		if err != nil {
			return fmt.Errorf("cannot verify host operation %s before service upgrade: %w", id, err)
		}
		status := response.Msg.GetStatus()
		switch status {
		case v1.OperationStatus_OPERATION_STATUS_SUCCEEDED, v1.OperationStatus_OPERATION_STATUS_FAILED:
			return nil
		case v1.OperationStatus_OPERATION_STATUS_PENDING, v1.OperationStatus_OPERATION_STATUS_RUNNING:
			if response.Msg.GetPhase() == upgradeAcceptedPhase {
				return nil
			}
		case v1.OperationStatus_OPERATION_STATUS_UNRESOLVED:
			if response.Msg.GetPhase() == upgradeAcceptedPhase {
				return nil
			}
			return fmt.Errorf(
				"host operation %s has unresolved effects in phase %s; service upgrade refused",
				id,
				response.Msg.GetPhase(),
			)
		case v1.OperationStatus_OPERATION_STATUS_UNSPECIFIED:
			return fmt.Errorf("host operation %s has unspecified status; service upgrade refused", id)
		default:
			return fmt.Errorf("host operation %s has invalid status; service upgrade refused", id)
		}
		timer := time.NewTimer(operationPollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fmt.Errorf("host operation %s remains active; service upgrade deferred: %w", id, ctx.Err())
		case <-timer.C:
		}
	}
}

func (e *environment) upgradeService(ctx context.Context) error {
	_, statErr := os.Lstat(e.HostRoot)
	if errors.Is(statErr, os.ErrNotExist) {
		return nil
	}
	if statErr != nil {
		return statErr
	}
	root, err := statefs.Open(e.HostRoot)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	// Resume a crash after bootout only with independent supervisor absence and
	// lifetime ownership proof. RPC failure by itself never establishes absence.
	if handled, stoppedErr := e.upgradeStoppedService(ctx, root, e.supervisorAbsent); handled || stoppedErr != nil {
		return stoppedErr
	}
	if err = e.drainHost(ctx); err != nil {
		return err
	}
	// Fence native mutation before stopping the service. An accepted worker can
	// no longer race from a harmless journal entry into its first native effect.
	fence, err := lockUpgradeMutation(ctx, root)
	if err != nil {
		return err
	}
	defer func() { _ = fence.Close() }()
	if err = e.verifyUpgradeJournal(ctx); err != nil {
		return err
	}
	if err = e.stopHost(ctx, false); err != nil {
		return err
	}
	lifetime, err := root.Lock(".service.lock", true)
	if err != nil {
		return err
	}
	defer func() { _ = lifetime.Close() }()
	if err = e.verifyUpgradeJournal(ctx); err != nil {
		return err
	}
	return root.WriteFile(filepath.Base(e.unitPath()), e.serviceDefinition())
}

const (
	upgradeAcceptedPhase   = "accepted"
	supervisorFailedStatus = "failed"
)

func lockUpgradeMutation(ctx context.Context, root *statefs.Dir) (*statefs.Lock, error) {
	bounded, cancel := context.WithTimeout(ctx, upgradeDrainTimeout)
	defer cancel()
	for {
		lock, err := root.Lock(".lock", true)
		if err == nil {
			return lock, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, err
		}
		timer := time.NewTimer(operationPollInterval)
		select {
		case <-bounded.Done():
			timer.Stop()
			return nil, fmt.Errorf("native work still owns mutation lock; upgrade deferred: %w", bounded.Err())
		case <-timer.C:
		}
	}
}

// Caller holds the native mutation fence. The persisted accepted phase is the
// engine contract that no native effects have begun; every other unfinished
// phase must be reconciled before service code replacement.
func (e *environment) verifyUpgradeJournal(ctx context.Context) error {
	uri := url.URL{Scheme: "file", Path: filepath.Join(e.HostRoot, "host.db"), RawQuery: "mode=ro"}
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	rows, err := db.QueryContext(ctx, "SELECT id,body FROM operations ORDER BY rowid")
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id string
		var raw []byte
		if err = rows.Scan(&id, &raw); err != nil {
			return err
		}
		var record struct {
			Phase    string         `json:"phase"`
			Response model.Response `json:"response"`
		}
		if err = json.Unmarshal(raw, &record); err != nil {
			return err
		}
		switch record.Response.Status {
		case "succeeded", supervisorFailedStatus:
		case "unresolved", "pending", "running":
			if record.Phase != upgradeAcceptedPhase {
				return fmt.Errorf("host operation %s has unfinished phase %s; upgrade refused", id, record.Phase)
			}
		default:
			return fmt.Errorf("host operation %s has invalid persisted status; upgrade refused", id)
		}
	}
	return rows.Err()
}

func (e *environment) supervisorAbsent(ctx context.Context) (bool, error) {
	if runtime.GOOS == macPlatform {
		target := "gui/" + strconv.Itoa(os.Getuid()) + "/" + e.Namespace
		out, err := command(ctx, "/bin/launchctl", "print", target)
		if err == nil {
			return false, nil
		}
		if missingLaunchdService(out) {
			return true, nil
		}
		return false, err
	}
	out, err := command(ctx, "systemctl", "--user", "is-active", e.Namespace+".service")
	status := strings.TrimSpace(string(out))
	if err == nil {
		return false, nil
	}
	if status == "inactive" || status == supervisorFailedStatus {
		return true, nil
	}
	return false, err
}

func (e *environment) upgradeStoppedService(
	ctx context.Context, root *statefs.Dir, observe func(context.Context) (bool, error),
) (bool, error) {
	lifetime, err := root.Lock(".service.lock", true)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer func() { _ = lifetime.Close() }()
	absent, err := observe(ctx)
	if err != nil || !absent {
		return false, err
	}
	fence, err := lockUpgradeMutation(ctx, root)
	if err != nil {
		return true, err
	}
	defer func() { _ = fence.Close() }()
	if err = e.verifyUpgradeJournal(ctx); err != nil {
		return true, err
	}
	return true, root.WriteFile(filepath.Base(e.unitPath()), e.serviceDefinition())
}
