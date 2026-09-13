package vt

import (
	"encoding/json"
	"errors"
	"fmt"
)

const (
	layoutSchema      = 1
	layoutPointerSize = 4
	layoutEndian      = "little"
)

// layout is the C ABI description that the pinned module publishes through
// ghostty_type_json. Struct offsets and enum values come from here, never from
// hand-written constants, so a rebuilt artifact cannot silently shift fields.
type layout struct {
	Schema int                 `json:"schema"`
	ABI    layoutABI           `json:"abi"`
	Types  map[string]typeInfo `json:"types"`
}

type layoutABI struct {
	PointerSize int    `json:"pointer_size"`
	Endian      string `json:"endian"`
}

type typeInfo struct {
	Size   uint32               `json:"size"`
	Kind   string               `json:"kind"`
	Fields map[string]fieldInfo `json:"fields"`
	Values map[string]int64     `json:"values"`
}

type fieldInfo struct {
	Offset uint32 `json:"offset"`
	Size   uint32 `json:"size"`
}

var errUnsupportedABI = errors.New("unsupported ghostty WASM ABI")

func parseLayout(raw []byte) (*layout, error) {
	var l layout
	if err := json.Unmarshal(raw, &l); err != nil {
		return nil, fmt.Errorf("decode Ghostty type layout: %w", err)
	}
	if l.Schema != layoutSchema || l.ABI.PointerSize != layoutPointerSize || l.ABI.Endian != layoutEndian {
		return nil, errUnsupportedABI
	}
	return &l, nil
}

func (l *layout) typ(name string) (typeInfo, error) {
	t, ok := l.Types[name]
	if !ok {
		return typeInfo{}, fmt.Errorf("missing Ghostty ABI type %q", name)
	}
	return t, nil
}

// value returns an enum member as the u32 the C ABI passes for it.
func (l *layout) value(typeName, member string) (uint32, error) {
	t, err := l.typ(typeName)
	if err != nil {
		return 0, err
	}
	v, ok := t.Values[member]
	if !ok {
		return 0, fmt.Errorf("missing Ghostty enum %s.%s", typeName, member)
	}
	return uint32(int32(v)), nil
}

func (l *layout) field(typeName, name string) (fieldInfo, error) {
	t, err := l.typ(typeName)
	if err != nil {
		return fieldInfo{}, err
	}
	f, ok := t.Fields[name]
	if !ok {
		return fieldInfo{}, fmt.Errorf("missing Ghostty field %s.%s", typeName, name)
	}
	return f, nil
}
