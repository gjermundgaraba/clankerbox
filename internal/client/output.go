package client

import (
	"fmt"
	"strings"
	"text/tabwriter"

	"clankerbox/internal/model"
)

func (runner commandRunner) output(value any) error {
	if runner.structured {
		return jsonOut(runner.streams.Out, value)
	}
	switch v := value.(type) {
	case *model.Machine:
		return runner.output(*v)
	case *model.Checkpoint:
		return runner.output(*v)
	case *[]model.Machine:
		return runner.machines(*v)
	case *[]model.Profile:
		return runner.profiles(*v)
	case *[]model.HostStatus:
		return runner.hosts(*v)
	case *[]model.Checkpoint:
		return runner.checkpoints(*v)
	case model.Machine:
		_, err := fmt.Fprintf(
			runner.streams.Out,
			"%s (%s)\nState: %s  Profile: %s  Host: %s  Observation stale: %t\n%s",
			v.Name,
			v.ID,
			v.State,
			v.Profile,
			v.Host,
			v.ObservationStale,
			optionalLine(v.ObservationError),
		)
		return err
	case model.Checkpoint:
		_, err := fmt.Fprintf(
			runner.streams.Out,
			"Checkpoint %s: %s\nKind: %s  Source: %s  Host: %s\n",
			v.ID,
			v.Status,
			v.Kind,
			v.SourceMachineID,
			v.Host,
		)
		return err
	case model.Operation:
		_, err := fmt.Fprintf(
			runner.streams.Out,
			"Operation %s: %s %s\nMachine: %s  Checkpoint: %s\n%s",
			v.ID,
			v.Action,
			v.Status,
			v.MachineID,
			v.CheckpointID,
			optionalLine(v.Error),
		)
		return err
	default:
		return fmt.Errorf("unsupported CLI output %T", value)
	}
}

func optionalLine(s string) string {
	if s == "" {
		return ""
	}
	return s + "\n"
}
func (runner commandRunner) machines(items []model.Machine) error {
	w := tabwriter.NewWriter(runner.streams.Out, 0, tableTabWidth, tablePadding, ' ', 0)
	if _, err := fmt.Fprintln(w, "NAME\tID\tSTATE\tPROFILE\tHOST"); err != nil {
		return err
	}
	for _, m := range items {
		if _, err := fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", m.Name, m.ID, m.State, m.Profile, m.Host); err != nil {
			return err
		}
	}
	return w.Flush()
}
func (runner commandRunner) profiles(items []model.Profile) error {
	w := tabwriter.NewWriter(runner.streams.Out, 0, tableTabWidth, tablePadding, ' ', 0)
	if _, err := fmt.Fprintln(w, "PROFILE\tOS/ARCH\tRUNTIME\tCPU\tRAM MiB\tCAPABILITIES"); err != nil {
		return err
	}
	for _, p := range items {
		if _, err := fmt.Fprintf(
			w,
			"%s\t%s/%s\t%s\t%d\t%d\t%s\n",
			p.ID,
			p.OS,
			p.Arch,
			p.Runtime,
			p.CPU,
			p.RAMMiB,
			strings.Join(p.Capabilities, ","),
		); err != nil {
			return err
		}
	}
	return w.Flush()
}
func formatRAM(mib int) string {
	const mibPerGiB = 1024
	if mib > -mibPerGiB && mib < mibPerGiB {
		return fmt.Sprintf("%d MiB", mib)
	}
	value := strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.2f", float64(mib)/mibPerGiB), "0"), ".")
	return value + " GiB"
}

func (runner commandRunner) hosts(items []model.HostStatus) error {
	w := tabwriter.NewWriter(runner.streams.Out, 0, tableTabWidth, tablePadding, ' ', 0)
	if _, err := fmt.Fprintln(
		w,
		"HOST\tPROFILES\tCPU TOTAL\tUSED\tREMAINING\tRAM TOTAL\tUSED\tREMAINING",
	); err != nil {
		return err
	}
	for _, h := range items {
		if _, err := fmt.Fprintf(
			w,
			"%s\t%s\t%d\t%d\t%d\t%s\t%s\t%s\n",
			h.ID,
			strings.Join(h.ProfileIDs, ","),
			h.CPU,
			h.UsedCPU,
			h.RemainingCPU,
			formatRAM(h.RAMMiB),
			formatRAM(h.UsedRAMMiB),
			formatRAM(h.RemainingRAMMiB),
		); err != nil {
			return err
		}
	}
	return w.Flush()
}
func (runner commandRunner) checkpoints(items []model.Checkpoint) error {
	w := tabwriter.NewWriter(runner.streams.Out, 0, tableTabWidth, tablePadding, ' ', 0)
	if _, err := fmt.Fprintln(w, "CHECKPOINT\tSTATUS\tKIND\tSOURCE\tHOST"); err != nil {
		return err
	}
	for _, c := range items {
		if _, err := fmt.Fprintf(
			w,
			"%s\t%s\t%s\t%s\t%s\n",
			c.ID,
			c.Status,
			c.Kind,
			c.SourceMachineID,
			c.Host,
		); err != nil {
			return err
		}
	}
	return w.Flush()
}

const (
	tableTabWidth = 4
	tablePadding  = 2
)
