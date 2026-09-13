module clankerbox/spikes/real-local-engine/prod-cold-bootstrap

go 1.27.1

require (
	clankerbox v0.0.0
	connectrpc.com/connect v1.21.0
	github.com/google/uuid v1.6.0
	modernc.org/sqlite v1.58.0
)

require (
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	github.com/tetratelabs/wazero v1.12.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
	modernc.org/libc v1.75.7 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.12.1 // indirect
)

replace clankerbox => ../../..
