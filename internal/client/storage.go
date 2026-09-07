package client

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"clankerbox/internal/statefs"
)

func readJSONFile(path string, out any) error {
	b, e := statefs.ReadPrivate(path)
	if errors.Is(e, os.ErrNotExist) {
		return nil
	}
	if e != nil {
		return e
	}
	if bytes.Equal(bytes.TrimSpace(b), []byte("null")) {
		return fmt.Errorf("invalid null state file %s", path)
	}
	if e = json.Unmarshal(b, out); e != nil {
		return fmt.Errorf("invalid state file %s", path)
	}
	return nil
}
func writeJSONFile(path string, v any) error {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	return statefs.WritePrivate(path, append(b, '\n'))
}
