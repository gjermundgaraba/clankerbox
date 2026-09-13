package dev

import "time"

const (
	controllerShutdownTimeout = 10 * time.Second
	serviceStartupTimeout     = 30 * time.Second
	readinessPollInterval     = 100 * time.Millisecond
	supervisorTimeout         = 20 * time.Second
	operationPollInterval     = 200 * time.Millisecond
	hostShutdownTimeout       = 45 * time.Second
	teardownTimeout           = 15 * time.Minute
	defaultMachineSlots       = 2
)
