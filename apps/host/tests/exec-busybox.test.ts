import { shellCases, underShell } from "./exec-cases.ts";

underShell("busybox ash", shellCases);
