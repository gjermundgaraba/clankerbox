package host

import (
	"encoding/json"
	"errors"
	"testing"

	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

func TestRevisionDeletionRespectsRetainedReferences(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"machine", "checkpoint", "operation"} {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			h, _, recipe := profileFixture(t)
			s := buildService(t, h)
			id := model.NewID()
			profile := recipe.Resolve(h.cfg.Bases[0].Base, id)
			descriptor, err := json.Marshal(preparedRevision{RuntimeDigest: h.cfg.RuntimeDigest, Profile: profile, Base: h.cfg.Bases[0].Base})
			registryCheck(t, err)
			registryCheck(t, statefs.WritePrivate(h.cfg.revisionPath(id), descriptor))
			referenceID := model.NewID()
			for _, finished := range []bool{false, true} {
				var value any
				var query string
				switch kind {
				case "machine":
					value = Manifest{ID: referenceID, Profile: profile, Deleted: finished}
					query = "INSERT OR REPLACE INTO machines(id,body) VALUES(?,?)"
				case "checkpoint":
					status := "published"
					if finished {
						status = "deleted"
					}
					value = ownedCheckpoint{ID: referenceID, Profile: profile, Status: status}
					query = "INSERT OR REPLACE INTO checkpoints(id,body) VALUES(?,?)"
				case "operation":
					status := "unresolved"
					if finished {
						status = "failed"
					}
					value = accepted{Request: model.Request{Profile: profile}, Response: model.Response{Status: status}}
					query = "INSERT OR REPLACE INTO operations(id,body,fingerprint,machine_id,generation) VALUES(?,?,'test','machine',1)"
				}
				raw, marshalErr := json.Marshal(value)
				registryCheck(t, marshalErr)
				_, err = h.db.ExecContext(t.Context(), query, referenceID, raw)
				registryCheck(t, err)
				err = s.DeleteProfileRevision(t.Context(), id)
				if finished {
					registryCheck(t, err)
				} else {
					var domain *model.Error
					if !errors.As(err, &domain) || domain.Reason != model.ReasonDependency {
						t.Fatalf("lost %s reference: %v", kind, err)
					}
				}
			}
		})
	}
}
