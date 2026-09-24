package client

import (
	"fmt"
	"io"
	"strconv"
	"strings"
	"text/tabwriter"
	"unicode"

	"clankerbox/internal/model"
)

const tablePadding = 2

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
	case *[]model.ProfileRevision:
		return runner.revisions(*v)
	case *[]model.Profile:
		return runner.profiles(*v)
	case *[]model.HostStatus:
		return runner.hosts(*v)
	case *[]model.Checkpoint:
		return runner.checkpoints(*v)
	case model.ProfileBuild:
		_, err := fmt.Fprintf(runner.streams.Out, "Build %s: %s (%s)\n%s", v.ID, v.Status, v.Phase, optionalLine(v.Error))
		return err
	case []model.Base:
		for _, b := range v {
			if _, err := fmt.Fprintf(runner.streams.Out, "%s\t%s/%s\t%s\t%s\n", b.ID, b.OS, b.Arch, b.Runtime, b.Digest); err != nil {
				return err
			}
		}
		return nil
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

// writeTable writes a header and one row per item as space-aligned columns.
// Control characters in cells become spaces so that no value can split a row
// or shift the columns.
func writeTable[T any](out io.Writer, header []string, items []T, row func(T) []string) error {
	w := tabwriter.NewWriter(out, 0, 0, tablePadding, ' ', 0)
	rows := [][]string{header}
	for _, item := range items {
		rows = append(rows, row(item))
	}
	for _, cells := range rows {
		line := make([]string, len(cells))
		for i, cell := range cells {
			line[i] = strings.Map(printable, cell)
		}
		if _, err := fmt.Fprintln(w, strings.Join(line, "\t")); err != nil {
			return err
		}
	}
	return w.Flush()
}

func printable(r rune) rune {
	if unicode.IsControl(r) {
		return ' '
	}
	return r
}

func (runner commandRunner) machines(items []model.Machine) error {
	header := []string{"NAME", "ID", "STATE", "PROFILE", "HOST"}
	return writeTable(runner.streams.Out, header, items, func(m model.Machine) []string {
		return []string{m.Name, m.ID, string(m.State), m.Profile, m.Host}
	})
}

func (runner commandRunner) profiles(items []model.Profile) error {
	header := []string{"PROFILE", "HOST", "REVISION", "OS/ARCH", "RUNTIME", "CPU", "RAM MiB", "CAPABILITIES"}
	return writeTable(runner.streams.Out, header, items, func(p model.Profile) []string {
		return []string{
			p.ID, p.HostID, p.RevisionID, p.OS + "/" + p.Arch, p.Runtime, strconv.Itoa(p.CPU), strconv.Itoa(p.RAMMiB),
			strings.Join(model.RuntimeCapabilities(p.Runtime, p.Arch), ","),
		}
	})
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
	header := []string{"HOST", "CPU TOTAL", "USED", "REMAINING", "RAM TOTAL", "USED", "REMAINING"}
	return writeTable(runner.streams.Out, header, items, func(h model.HostStatus) []string {
		return []string{
			h.ID, strconv.Itoa(h.CPU), strconv.Itoa(h.UsedCPU), strconv.Itoa(h.RemainingCPU),
			formatRAM(h.RAMMiB), formatRAM(h.UsedRAMMiB), formatRAM(h.RemainingRAMMiB),
		}
	})
}

func (runner commandRunner) checkpoints(items []model.Checkpoint) error {
	header := []string{"CHECKPOINT", "STATUS", "KIND", "SOURCE", "HOST"}
	return writeTable(runner.streams.Out, header, items, func(c model.Checkpoint) []string {
		return []string{c.ID, c.Status, c.Kind, c.SourceMachineID, c.Host}
	})
}

func (runner commandRunner) revisions(items []model.ProfileRevision) error {
	header := []string{"PROFILE", "REVISION", "HOST", "STATE"}
	return writeTable(runner.streams.Out, header, items, func(r model.ProfileRevision) []string {
		state := "retained"
		if r.Deleting {
			state = "deleting"
		}
		return []string{r.ID, r.RevisionID, r.HostID, state}
	})
}
