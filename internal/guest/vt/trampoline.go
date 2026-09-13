package vt

import "encoding/binary"

// The pinned module imports nothing, so a Go callback cannot be named directly
// in a Ghostty option. This file assembles a tiny module that imports Ghostty's
// function table and one host function, re-exports the host function under a C
// ABI signature, and exports install(), which grows the table by one slot
// holding that function and returns the slot index. Ghostty then calls the Go
// code through call_indirect exactly as it would call a C function pointer.

const (
	wasmMagicVersion = "\x00asm\x01\x00\x00\x00"
	sectionType      = 1
	sectionImport    = 2
	sectionFunction  = 3
	sectionExport    = 7
	sectionCode      = 10
	typeFunc         = 0x60
	valueI32         = 0x7f
	refFuncref       = 0x70
	importFunc       = 0x00
	importTable      = 0x01
	exportFunc       = 0x00
	opRefFunc        = 0xd2
	opI32Const       = 0x41
	opPrefixFC       = 0xfc
	opTableGrow      = 0x0f
	opEnd            = 0x0b
)

// trampoline returns a module importing table "__indirect_function_table" from
// module tableModule and function "cbk" from module hostModule with the given
// i32 parameter count and optional i32 result.
func trampoline(tableModule, hostModule string, params int, returns bool) []byte {
	sig := []byte{typeFunc, byte(params)}
	for range params {
		sig = append(sig, valueI32)
	}
	if returns {
		sig = append(sig, 1, valueI32)
	} else {
		sig = append(sig, 0)
	}
	types := append([]byte{2}, sig...)
	types = append(types, typeFunc, 0, 1, valueI32)

	imports := []byte{2}
	imports = append(imports, wasmName(tableModule)...)
	imports = append(imports, wasmName("__indirect_function_table")...)
	imports = append(imports, importTable, refFuncref, 0, 0)
	imports = append(imports, wasmName(hostModule)...)
	imports = append(imports, wasmName("cbk")...)
	imports = append(imports, importFunc, 0)

	exports := []byte{2}
	exports = append(exports, wasmName("cbk")...)
	exports = append(exports, exportFunc, 0)
	exports = append(exports, wasmName("install")...)
	exports = append(exports, exportFunc, 1)

	// install: (table.grow 0 (ref.func 0) (i32.const 1)) returns the old size.
	body := []byte{0, opRefFunc, 0, opI32Const, 1, opPrefixFC, opTableGrow, 0, opEnd}
	code := append([]byte{1, byte(len(body))}, body...)

	module := []byte(wasmMagicVersion)
	module = append(module, wasmSection(sectionType, types)...)
	module = append(module, wasmSection(sectionImport, imports)...)
	module = append(module, wasmSection(sectionFunction, []byte{1, 1})...)
	module = append(module, wasmSection(sectionExport, exports)...)
	module = append(module, wasmSection(sectionCode, code)...)
	return module
}

func wasmSection(id byte, payload []byte) []byte {
	out := binary.AppendUvarint([]byte{id}, uint64(len(payload)))
	return append(out, payload...)
}

func wasmName(s string) []byte {
	return append(binary.AppendUvarint(nil, uint64(len(s))), s...)
}
