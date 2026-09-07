package host

import "time"

const (
	runtimeSmolvm          = "smolvm"
	statusFailed           = "failed"
	statusUnresolved       = "unresolved"
	statusSucceeded        = "succeeded"
	actionCapture          = "checkpoint-create"
	actionDeleteCheckpoint = "checkpoint-delete"
	checkpointDisk         = "disk"
	checkpointRAM          = "ram"
	phaseDone              = "done"
	phaseAccepted          = "accepted"
	actionFork             = "fork"
	actionRestore          = "restore"
	runtimeTart            = "tart"
	actionStart            = "start"
	actionDelete           = "delete"
	actionCreate           = "create"
	smolvmMachineCommand   = "machine"
	nameFlag               = "--name"
	archAMD64              = "amd64"
	actionStop             = "stop"
	shellStrictFlags       = "-se"
	stateRunning           = "running"
	stateStopped           = "stopped"
)

const (
	guestReadyTimeout      = 90 * time.Second
	identityAttemptTimeout = 3 * time.Second
	runtimeStartTimeout    = 240 * time.Second
	connectionTimeout      = 10 * time.Second
	supervisorStopTimeout  = 20 * time.Second
	commandWaitDelay       = 2 * time.Second
	identityRetryInterval  = 100 * time.Millisecond
	unixSocketPathLimit    = 108
	runtimeOutputLimit     = 1 << 20
	runtimeErrorLimit      = 4096
	runtimeExec            = "exec"
)
