module clankerbox/spikes/real-local-guest

go 1.27.1

require (
	clankerbox v0.0.0-00010101000000-000000000000
	connectrpc.com/connect v1.21.0
	github.com/google/uuid v1.6.0
	golang.org/x/sys v0.48.0
	google.golang.org/protobuf v1.36.12
)

require (
	github.com/creack/pty v1.1.24 // indirect
	github.com/tetratelabs/wazero v1.12.0 // indirect
)

replace clankerbox => ../..
