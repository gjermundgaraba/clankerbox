import { shellCases, underEachShell } from "./exec-cases.ts";

underEachShell(shellCases, "busybox");
