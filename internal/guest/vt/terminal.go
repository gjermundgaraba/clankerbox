package vt

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

const (
	formatterOptionsType   = "GhosttyFormatterTerminalOptions"
	defaultScrollbackLines = 10_000
	defaultScrollbackBytes = 8 * 1024 * 1024
	// Bounded so a snapshot fits maxSnapshotBytes; the desk engine uses the same value.
	defaultContinuationMax  = 8 * 1024 * 1024
	inputBufferSize         = 64 * 1024
	scratchSize             = 1024
	pointerSize             = 4
	resultSuccess           = 0
	resultOutOfSpace        = -3
	deviceConformanceLevel  = 62
	deviceFeatureANSIColor  = 22
	deviceFeatureANSIText   = 28
	deviceFeatureCount      = 2
	deviceSecondaryVT220    = 1
	uint16Size              = 2
	writePtyCallbackParams  = 4
	deviceAttrCallbackParam = 3
	defaultCellWidthPx      = 8
	defaultCellHeightPx     = 16
	defaultForegroundR      = 212
	defaultForegroundG      = 222
	defaultForegroundB      = 219
	defaultBackgroundR      = 21
	defaultBackgroundG      = 25
	defaultBackgroundB      = 28
)

var (
	errClosed         = errors.New("ghostty terminal is closed")
	errAllocation     = errors.New("ghostty allocation failed")
	errMemory         = errors.New("ghostty memory access out of range")
	errTrailingBytes  = errors.New("trailing Ghostty snapshot bytes")
	errTableGrow      = errors.New("ghostty function table cannot grow")
	errTypeJSONFormat = errors.New("ghostty type layout is not NUL terminated")
)

// runtimeConstruction serializes wazero.NewRuntime. wazero 1.12 caches its version
// string in an unsynchronized package global on first construction, which the race
// detector reports when several daemons start inside one test process. Compilation
// runs outside the lock.
var runtimeConstruction sync.Mutex //nolint:gochecknoglobals // Guards an upstream global; see NewLoader.

// Loader compiles the pinned module once and instantiates isolated terminals.
type Loader struct {
	runtime  wazero.Runtime
	compiled wazero.CompiledModule
	counter  atomic.Uint64
}

// NewLoader compiles the embedded artifact.
func NewLoader(ctx context.Context) (*Loader, error) {
	runtimeConstruction.Lock()
	runtime := wazero.NewRuntime(ctx)
	runtimeConstruction.Unlock()
	compiled, err := runtime.CompileModule(ctx, asset)
	if err != nil {
		_ = runtime.Close(ctx)
		return nil, fmt.Errorf("compile Ghostty module: %w", err)
	}
	return &Loader{runtime: runtime, compiled: compiled}, nil
}

// Close releases every terminal created by this loader.
func (l *Loader) Close(ctx context.Context) error {
	if err := l.runtime.Close(ctx); err != nil {
		return fmt.Errorf("close Ghostty runtime: %w", err)
	}
	return nil
}

// Options configures one terminal.
type Options struct {
	Cols uint16
	Rows uint16
	// OnWritePTY receives protocol replies the terminal must send to the PTY.
	// It runs synchronously inside Write and must not call back into the terminal.
	OnWritePTY func([]byte)
}

// Terminal is one libghostty-vt instance with its own linear memory.
type Terminal struct {
	mu        sync.Mutex
	ctx       context.Context //nolint:containedctx // wazero calls need the runtime context.
	loader    *Loader
	module    api.Module
	mem       api.Memory
	layout    *layout
	functions map[string]api.Function
	owned     []api.Module
	callbacks map[string]uint64
	slot      uint32
	scratch   uint32
	input     uint32
	handle    uint32
	cols      uint16
	rows      uint16
	closed    bool
}

// New instantiates a terminal.
func (l *Loader) New(ctx context.Context, opts Options) (*Terminal, error) {
	id := strconv.FormatUint(l.counter.Add(1), 10)
	module, err := l.runtime.InstantiateModule(ctx, l.compiled, wazero.NewModuleConfig().WithName("ghostty-"+id))
	if err != nil {
		return nil, fmt.Errorf("instantiate Ghostty module: %w", err)
	}
	t := &Terminal{
		ctx:       ctx,
		loader:    l,
		module:    module,
		mem:       module.Memory(),
		functions: make(map[string]api.Function),
		callbacks: make(map[string]uint64),
		cols:      opts.Cols,
		rows:      opts.Rows,
	}
	if err = t.initialize(id, opts); err != nil {
		_ = t.Close()
		return nil, err
	}
	return t, nil
}

func (t *Terminal) initialize(id string, opts Options) error {
	if err := t.loadLayout(); err != nil {
		return err
	}
	var err error
	if t.slot, err = t.alloc(pointerSize); err != nil {
		return err
	}
	if t.scratch, err = t.alloc(scratchSize); err != nil {
		return err
	}
	if t.input, err = t.alloc(inputBufferSize); err != nil {
		return err
	}
	if err = t.call("ghostty_terminal_new", 0, uint64(t.slot), uint64(t.cols), uint64(t.rows)); err != nil {
		return err
	}
	if t.handle, err = t.u32(t.slot); err != nil {
		return err
	}
	if err = t.setLimits(); err != nil {
		return err
	}
	if err = t.setColors(); err != nil {
		return err
	}
	return t.installCallbacks(id, opts)
}

func (t *Terminal) loadLayout() error {
	ptr, err := t.result("ghostty_type_json")
	if err != nil {
		return err
	}
	start := uint32(ptr)
	end := start
	for {
		b, ok := t.mem.ReadByte(end)
		if !ok {
			return errTypeJSONFormat
		}
		if b == 0 {
			break
		}
		end++
	}
	raw, ok := t.mem.Read(start, end-start)
	if !ok {
		return errMemory
	}
	t.layout, err = parseLayout(raw)
	return err
}

func (t *Terminal) setLimits() error {
	for option, limit := range map[string]uint32{
		"SCROLLBACK_MAX_LINES":   defaultScrollbackLines,
		"SCROLLBACK_MAX_BYTES":   defaultScrollbackBytes,
		"CONTINUATION_MAX_BYTES": defaultContinuationMax,
	} {
		if err := t.setU32(t.scratch, limit); err != nil {
			return err
		}
		if err := t.setOption(t.handle, option, uint64(t.scratch)); err != nil {
			return err
		}
	}
	return nil
}

// Colors are default colours as 0xRRGGBB; nil leaves a colour unchanged.
type Colors struct {
	Foreground *uint32
	Background *uint32
}

// SetColors replaces the default colours the terminal reports and renders with.
func (t *Terminal) SetColors(colors Colors) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return errClosed
	}
	for option, color := range map[string]*uint32{
		"COLOR_FOREGROUND": colors.Foreground,
		"COLOR_BACKGROUND": colors.Background,
	} {
		if color == nil {
			continue
		}
		rgb := []byte{byte(*color >> 16), byte(*color >> 8), byte(*color)}
		if !t.mem.Write(t.scratch, rgb) {
			return errMemory
		}
		if err := t.setOption(t.handle, option, uint64(t.scratch)); err != nil {
			return err
		}
	}
	return nil
}

func (t *Terminal) setColors() error {
	colors := map[string][3]byte{
		"COLOR_FOREGROUND": {defaultForegroundR, defaultForegroundG, defaultForegroundB},
		"COLOR_BACKGROUND": {defaultBackgroundR, defaultBackgroundG, defaultBackgroundB},
	}
	for option, rgb := range colors {
		if !t.mem.Write(t.scratch, rgb[:]) {
			return errMemory
		}
		if err := t.setOption(t.handle, option, uint64(t.scratch)); err != nil {
			return err
		}
	}
	return nil
}

func (t *Terminal) installCallbacks(id string, opts Options) error {
	write := func(_ context.Context, _, _, ptr, n uint32) {
		if opts.OnWritePTY == nil {
			return
		}
		if data, ok := t.mem.Read(ptr, n); ok {
			opts.OnWritePTY(append([]byte(nil), data...))
		}
	}
	if err := t.bindCallback(id, "WRITE_PTY", writePtyCallbackParams, write); err != nil {
		return err
	}
	attributes := func(_ context.Context, _, _, ptr uint32) uint32 {
		if err := t.writeDeviceAttributes(ptr); err != nil {
			return 0
		}
		return 1
	}
	if err := t.bindCallback(id, "DEVICE_ATTRIBUTES", deviceAttrCallbackParam, attributes); err != nil {
		return err
	}
	return nil
}

// bindCallback publishes fn through a trampoline and sets it as a terminal option.
func (t *Terminal) bindCallback(id, option string, params int, fn any) error {
	hostName := "host-" + id + "-" + option
	host, err := t.loader.runtime.NewHostModuleBuilder(hostName).
		NewFunctionBuilder().WithFunc(fn).Export("cbk").Instantiate(t.ctx)
	if err != nil {
		return fmt.Errorf("instantiate callback host module: %w", err)
	}
	t.owned = append(t.owned, host)
	returns := option == "DEVICE_ATTRIBUTES"
	tramp, err := t.loader.runtime.InstantiateWithConfig(t.ctx,
		trampoline(t.module.Name(), hostName, params, returns),
		wazero.NewModuleConfig().WithName("tramp-"+id+"-"+option))
	if err != nil {
		return fmt.Errorf("instantiate callback trampoline: %w", err)
	}
	t.owned = append(t.owned, tramp)
	index, err := tramp.ExportedFunction("install").Call(t.ctx)
	if err != nil {
		return fmt.Errorf("install callback: %w", err)
	}
	if len(index) != 1 || int32(index[0]) < 0 {
		return errTableGrow
	}
	t.callbacks[option] = index[0]
	return t.setOption(t.handle, option, index[0])
}

func (t *Terminal) writeDeviceAttributes(ptr uint32) error {
	attributes, err := t.layout.typ("GhosttyDeviceAttributes")
	if err != nil {
		return err
	}
	if !t.mem.Write(ptr, make([]byte, attributes.Size)) {
		return errMemory
	}
	primary, err := t.layout.field("GhosttyDeviceAttributes", "primary")
	if err != nil {
		return err
	}
	base := ptr + primary.Offset
	conformance, err := t.layout.field("GhosttyDeviceAttributesPrimary", "conformance_level")
	if err != nil {
		return err
	}
	features, err := t.layout.field("GhosttyDeviceAttributesPrimary", "features")
	if err != nil {
		return err
	}
	count, err := t.layout.field("GhosttyDeviceAttributesPrimary", "num_features")
	if err != nil {
		return err
	}
	secondary, err := t.layout.field("GhosttyDeviceAttributes", "secondary")
	if err != nil {
		return err
	}
	ok := t.mem.WriteUint16Le(base+conformance.Offset, deviceConformanceLevel) &&
		t.mem.WriteUint16Le(base+features.Offset, deviceFeatureANSIColor) &&
		t.mem.WriteUint16Le(base+features.Offset+uint16Size, deviceFeatureANSIText) &&
		t.mem.WriteUint32Le(base+count.Offset, deviceFeatureCount) &&
		t.mem.WriteUint16Le(ptr+secondary.Offset, deviceSecondaryVT220)
	if !ok {
		return errMemory
	}
	return nil
}

// Size returns the current grid size.
func (t *Terminal) Size() (uint16, uint16) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.cols, t.rows
}

// Write feeds PTY output to the parser. Protocol replies are delivered through
// OnWritePTY before Write returns.
func (t *Terminal) Write(data []byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return errClosed
	}
	for len(data) > 0 {
		chunk := data
		if len(chunk) > inputBufferSize {
			chunk = data[:inputBufferSize]
		}
		if !t.mem.Write(t.input, chunk) {
			return errMemory
		}
		if err := t.call(
			"ghostty_terminal_vt_write",
			uint64(t.handle),
			uint64(t.input),
			uint64(len(chunk)),
		); err != nil {
			return err
		}
		data = data[len(chunk):]
	}
	return nil
}

// Resize changes the grid.
func (t *Terminal) Resize(cols, rows uint16) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return errClosed
	}
	if err := t.checked("ghostty_terminal_resize", uint64(t.handle), uint64(cols), uint64(rows),
		defaultCellWidthPx, defaultCellHeightPx); err != nil {
		return err
	}
	t.cols, t.rows = cols, rows
	return nil
}

// Snapshot encodes the complete terminal state, both screens and unfinished input.
func (t *Terminal) Snapshot() ([]byte, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil, errClosed
	}
	return t.encodeWithSizeQuery(func(ptr, capacity uint32) (uint64, error) {
		return t.result(
			"ghostty_snapshot_encode_buf",
			uint64(t.handle),
			uint64(ptr),
			uint64(capacity),
			uint64(t.scratch),
		)
	})
}

// encodeWithSizeQuery runs a two-pass buffer encoder: a zero-capacity call
// reports OUT_OF_SPACE with the required size in scratch, then a sized call fills it.
func (t *Terminal) encodeWithSizeQuery(encode func(ptr, capacity uint32) (uint64, error)) ([]byte, error) {
	status, err := encode(0, 0)
	if err != nil {
		return nil, err
	}
	if code := int32(status); code != resultOutOfSpace && code != resultSuccess {
		return nil, fmt.Errorf("ghostty operation failed (%d)", code)
	}
	size, err := t.u32(t.scratch)
	if err != nil {
		return nil, err
	}
	ptr, err := t.alloc(max(size, 1))
	if err != nil {
		return nil, err
	}
	defer t.free(ptr, max(size, 1))
	status, err = encode(ptr, size)
	if err != nil {
		return nil, err
	}
	if code := int32(status); code != resultSuccess {
		return nil, fmt.Errorf("ghostty operation failed (%d)", code)
	}
	written, err := t.u32(t.scratch)
	if err != nil {
		return nil, err
	}
	out, ok := t.mem.Read(ptr, written)
	if !ok {
		return nil, errMemory
	}
	return append([]byte(nil), out...), nil
}

// Restore atomically replaces parser state. Invalid snapshots leave the
// current terminal intact. Restoring never emits protocol replies.
func (t *Terminal) Restore(snapshot []byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return errClosed
	}
	size := uint32(max(len(snapshot), 1))
	ptr, err := t.alloc(size)
	if err != nil {
		return err
	}
	defer t.free(ptr, size)
	if !t.mem.Write(ptr, snapshot) {
		return errMemory
	}
	if err = t.call(
		"ghostty_snapshot_decoder_new_buf",
		0,
		uint64(t.slot),
		uint64(ptr),
		uint64(len(snapshot)),
	); err != nil {
		return err
	}
	decoder, err := t.u32(t.slot)
	if err != nil {
		return err
	}
	defer func() { _ = t.call("ghostty_snapshot_decoder_free", uint64(decoder)) }()
	replacement, err := t.decode(decoder, uint32(len(snapshot)))
	if err != nil {
		return err
	}
	for option, index := range t.callbacks {
		if err = t.setOption(replacement, option, index); err != nil {
			_ = t.call("ghostty_terminal_free", uint64(replacement))
			return err
		}
	}
	old := t.handle
	t.handle = replacement
	_ = t.call("ghostty_terminal_free", uint64(old))
	t.cols, t.rows, err = t.gridSize()
	return err
}

func (t *Terminal) decode(decoder, length uint32) (uint32, error) {
	if !t.mem.WriteByte(t.scratch, 1) {
		return 0, errMemory
	}
	retain, err := t.layout.value("GhosttySnapshotDecoderOption", "RETAIN_CONTINUATION")
	if err != nil {
		return 0, err
	}
	if err = t.checked(
		"ghostty_snapshot_decoder_set",
		uint64(decoder),
		uint64(retain),
		uint64(t.scratch),
	); err != nil {
		return 0, err
	}
	if err = t.checked("ghostty_snapshot_decoder_decode", uint64(decoder), uint64(t.slot)); err != nil {
		return 0, err
	}
	replacement, err := t.u32(t.slot)
	if err != nil {
		return 0, err
	}
	offsetKey, err := t.layout.value("GhosttySnapshotDecoderData", "SOURCE_OFFSET")
	if err != nil {
		return 0, err
	}
	if err = t.checked(
		"ghostty_snapshot_decoder_get",
		uint64(decoder),
		uint64(offsetKey),
		uint64(t.scratch),
	); err != nil {
		_ = t.call("ghostty_terminal_free", uint64(replacement))
		return 0, err
	}
	consumed, err := t.u32(t.scratch)
	if err != nil || consumed != length {
		_ = t.call("ghostty_terminal_free", uint64(replacement))
		if err != nil {
			return 0, err
		}
		return 0, errTrailingBytes
	}
	return replacement, nil
}

func (t *Terminal) gridSize() (uint16, uint16, error) {
	cols, err := t.dataU16("COLS")
	if err != nil {
		return 0, 0, err
	}
	rows, err := t.dataU16("ROWS")
	if err != nil {
		return 0, 0, err
	}
	return cols, rows, nil
}

// Cursor returns the cursor position in the active screen.
func (t *Terminal) Cursor() (uint16, uint16, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return 0, 0, errClosed
	}
	x, err := t.dataU16("CURSOR_X")
	if err != nil {
		return 0, 0, err
	}
	y, err := t.dataU16("CURSOR_Y")
	if err != nil {
		return 0, 0, err
	}
	return x, y, nil
}

// Text returns the active screen as plain text with trailing whitespace trimmed.
// Rows are separated by newlines; trailing blank rows are omitted.
func (t *Terminal) Text() (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return "", errClosed
	}
	options, err := t.formatterOptions()
	if err != nil {
		return "", err
	}
	defer t.free(options.ptr, options.size)
	if err = t.call(
		"ghostty_formatter_terminal_new",
		0,
		uint64(t.slot),
		uint64(t.handle),
		uint64(options.ptr),
	); err != nil {
		return "", err
	}
	formatter, err := t.u32(t.slot)
	if err != nil {
		return "", err
	}
	defer func() { _ = t.call("ghostty_formatter_free", uint64(formatter)) }()
	text, err := t.encodeWithSizeQuery(func(ptr, capacity uint32) (uint64, error) {
		return t.result(
			"ghostty_formatter_format_buf",
			uint64(formatter),
			uint64(ptr),
			uint64(capacity),
			uint64(t.scratch),
		)
	})
	if err != nil {
		return "", err
	}
	return string(text), nil
}

type allocation struct {
	ptr  uint32
	size uint32
}

func (t *Terminal) formatterOptions() (allocation, error) {
	options, err := t.layout.typ(formatterOptionsType)
	if err != nil {
		return allocation{}, err
	}
	ptr, err := t.alloc(options.Size)
	if err != nil {
		return allocation{}, err
	}
	out := allocation{ptr: ptr, size: options.Size}
	if !t.mem.Write(ptr, make([]byte, options.Size)) {
		return out, errMemory
	}
	plain, err := t.layout.value("GhosttyFormatterFormat", "PLAIN")
	if err != nil {
		return out, err
	}
	extra, err := t.layout.typ("GhosttyFormatterTerminalExtra")
	if err != nil {
		return out, err
	}
	screen, err := t.layout.typ("GhosttyFormatterScreenExtra")
	if err != nil {
		return out, err
	}
	writes := []struct {
		field  string
		parent string
		value  uint32
		byte   bool
	}{
		{"size", formatterOptionsType, options.Size, false},
		{"emit", formatterOptionsType, plain, false},
		{"trim", formatterOptionsType, 1, true},
	}
	for _, w := range writes {
		f, fieldErr := t.layout.field(w.parent, w.field)
		if fieldErr != nil {
			return out, fieldErr
		}
		if w.byte {
			if !t.mem.WriteByte(ptr+f.Offset, byte(w.value)) {
				return out, errMemory
			}
		} else if !t.mem.WriteUint32Le(ptr+f.Offset, w.value) {
			return out, errMemory
		}
	}
	extraField, err := t.layout.field(formatterOptionsType, "extra")
	if err != nil {
		return out, err
	}
	screenField, err := t.layout.field("GhosttyFormatterTerminalExtra", "screen")
	if err != nil {
		return out, err
	}
	extraPtr := ptr + extraField.Offset
	if !t.mem.WriteUint32Le(extraPtr, extra.Size) || !t.mem.WriteUint32Le(extraPtr+screenField.Offset, screen.Size) {
		return out, errMemory
	}
	return out, nil
}

// Close frees the terminal and its memory.
func (t *Terminal) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil
	}
	t.closed = true
	if t.handle != 0 {
		_ = t.call("ghostty_terminal_free", uint64(t.handle))
	}
	var errs []error
	for _, v := range slices.Backward(t.owned) {
		if err := v.Close(t.ctx); err != nil {
			errs = append(errs, err)
		}
	}
	if err := t.module.Close(t.ctx); err != nil {
		errs = append(errs, err)
	}
	if err := errors.Join(errs...); err != nil {
		return fmt.Errorf("close Ghostty terminal: %w", err)
	}
	return nil
}

func (t *Terminal) dataU16(key string) (uint16, error) {
	k, err := t.layout.value("GhosttyTerminalData", key)
	if err != nil {
		return 0, err
	}
	if err = t.checked("ghostty_terminal_get", uint64(t.handle), uint64(k), uint64(t.scratch)); err != nil {
		return 0, err
	}
	v, ok := t.mem.ReadUint16Le(t.scratch)
	if !ok {
		return 0, errMemory
	}
	return v, nil
}

func (t *Terminal) setOption(handle uint32, option string, value uint64) error {
	key, err := t.layout.value("GhosttyTerminalOption", option)
	if err != nil {
		return err
	}
	return t.checked("ghostty_terminal_set", uint64(handle), uint64(key), value)
}

func (t *Terminal) function(name string) (api.Function, error) {
	if fn, ok := t.functions[name]; ok {
		return fn, nil
	}
	fn := t.module.ExportedFunction(name)
	if fn == nil {
		return nil, fmt.Errorf("missing Ghostty export %q", name)
	}
	t.functions[name] = fn
	return fn, nil
}

// result calls an export and returns its first result.
func (t *Terminal) result(name string, args ...uint64) (uint64, error) {
	fn, err := t.function(name)
	if err != nil {
		return 0, err
	}
	out, err := fn.Call(t.ctx, args...)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", name, err)
	}
	if len(out) == 0 {
		return 0, nil
	}
	return out[0], nil
}

// call runs an export and ignores its result.
func (t *Terminal) call(name string, args ...uint64) error {
	_, err := t.result(name, args...)
	return err
}

// checked runs an export that returns GhosttyResult and fails unless SUCCESS.
func (t *Terminal) checked(name string, args ...uint64) error {
	status, err := t.result(name, args...)
	if err != nil {
		return err
	}
	if code := int32(status); code != resultSuccess {
		return fmt.Errorf("%s failed (%d)", name, code)
	}
	return nil
}

func (t *Terminal) alloc(size uint32) (uint32, error) {
	ptr, err := t.result("ghostty_wasm_alloc", uint64(size))
	if err != nil {
		return 0, err
	}
	if ptr == 0 {
		return 0, errAllocation
	}
	return uint32(ptr), nil
}

func (t *Terminal) free(ptr, size uint32) {
	_ = t.call("ghostty_wasm_free", uint64(ptr), uint64(size))
}

func (t *Terminal) u32(ptr uint32) (uint32, error) {
	v, ok := t.mem.ReadUint32Le(ptr)
	if !ok {
		return 0, errMemory
	}
	return v, nil
}

func (t *Terminal) setU32(ptr, v uint32) error {
	if !t.mem.WriteUint32Le(ptr, v) {
		return errMemory
	}
	return nil
}
