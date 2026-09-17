import assert from "node:assert/strict";
import test from "node:test";
import { create, fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import {
  SessionSchema, SessionStatus, OpenSchema, OpenedSchema, OpenMode,
  AttachmentRequestSchema, AttachmentEventSchema, MachineService, HostService,
  SessionService, ErrorDetailSchema, ErrorReason,
  ProfileService, HostProfileService, ProfileSchema, ProfileBuildStatus, ProfileBuildSchema, UploadRecipeRequestSchema,
} from "../dist/index.js";

test("generated uint64 uses bigint and protobuf JSON decimal strings", () => {
  const session = create(SessionSchema, {
    id: "session", status: SessionStatus.RUNNING, cols: 80, rows: 24,
    offset: 9007199254741993n, retainedFrom: 9007199254740993n,
    lastResizeOffset: 9007199254741000n, replyOverflow: 18446744073709551615n,
    pid: 1234n, exitCode: 0, signal: "", endedAt: "",
  });
  const restored = fromBinary(SessionSchema, toBinary(SessionSchema, session));
  assert.equal(restored.offset, session.offset);
  assert.equal(typeof restored.offset, "bigint");
  assert.equal(restored.replyOverflow, 18446744073709551615n);
  assert.equal(restored.exitCode, 0);
  assert.equal(restored.signal, "");
  const json = toJson(SessionSchema, session);
  assert.equal(json.offset, "9007199254741993");
  assert.equal(fromJson(SessionSchema, json).offset, session.offset);
  const absent = create(SessionSchema, {});
  assert.equal(fromBinary(SessionSchema, toBinary(SessionSchema, absent)).exitCode, undefined);
});

test("atomic cut and resume start remain distinct; final screen cursor is typed", () => {
  const opened = create(OpenedSchema, {
    mode: OpenMode.ENDED, cut: 9007199254741993n, startOffset: 9007199254740993n,
    view: { cursor: { x: 79, y: 23 }, bytes: 8388721n },
  });
  const restored = fromBinary(OpenedSchema, toBinary(OpenedSchema, opened));
  assert.notEqual(restored.cut, restored.startOffset);
  assert.equal(restored.view.cursor.x, 79);
  assert.equal(restored.view.bytes, 8388721n);
  const absent = create(OpenSchema, { machineId: "machine", sessionId: "session" });
  assert.equal(absent.resumeCursor, undefined);
  const explicitZero = create(OpenSchema, { resumeCursor: { offset: 0n, incarnation: "old" } });
  assert.equal(fromBinary(OpenSchema, toBinary(OpenSchema, explicitZero)).resumeCursor.offset, 0n);
});

test("shared typed attachment and service methods have the intended shapes", () => {
  for (const service of [SessionService]) {
    const attach = service.method.attachSession;
    assert.equal(attach.methodKind, "bidi_streaming");
    assert.equal(attach.input.typeName, AttachmentRequestSchema.typeName);
    assert.equal(attach.output.typeName, AttachmentEventSchema.typeName);
    assert.equal(service.method.endSession.methodKind, "unary");
  }
  assert.equal(HostService.method.attachSession, undefined);
  assert.equal(HostService.method.createSession, undefined);
  assert.equal(MachineService.method.setLabels.output.typeName, "clankerbox.v1.Machine");
  assert.equal(MachineService.method.createMachine.output.typeName, "clankerbox.v1.Operation");
  const frame = create(AttachmentRequestSchema, {
    command: { case: "input", value: { sequence: 18446744073709551615n, data: new Uint8Array([97]) } },
  });
  const restored = fromBinary(AttachmentRequestSchema, toBinary(AttachmentRequestSchema, frame));
  assert.equal(restored.command.case, "input");
  assert.equal(restored.command.value.sequence, 18446744073709551615n);
});

test("typed prerequisite, capacity and unsupported errors stay distinct", () => {
  for (const reason of [ErrorReason.PREREQUISITE, ErrorReason.CAPACITY, ErrorReason.UNSUPPORTED, ErrorReason.UNAVAILABLE]) {
    const detail = create(ErrorDetailSchema, { reason, resourceId: "machine" });
    assert.equal(fromBinary(ErrorDetailSchema, toBinary(ErrorDetailSchema, detail)).reason, reason);
  }
});


test("profile builds preserve revision pins and chunk offsets", () => {
  const build = create(ProfileBuildSchema, { id: "revision-a", recipe: { id: "dev", hostId: "local", baseId: "linux-base" }, base: { id: "linux-base", digest: "base-digest" }, status: ProfileBuildStatus.SUCCEEDED });
  const restored = fromBinary(ProfileBuildSchema, toBinary(ProfileBuildSchema, build));
  assert.equal(restored.id, "revision-a");
  assert.equal(restored.recipe.hostId, "local");
  assert.equal(restored.status, ProfileBuildStatus.SUCCEEDED);
  assert.equal(restored.base.digest, "base-digest");
  assert.notEqual(ProfileService.method.publishProfile.input, HostProfileService.method.publishProfile.input);
  const chunk = create(UploadRecipeRequestSchema, { uploadId: "upload", offset: 9007199254741993n, data: new Uint8Array([1, 2]), complete: true });
  assert.equal(fromBinary(UploadRecipeRequestSchema, toBinary(UploadRecipeRequestSchema, chunk)).offset, chunk.offset);
  for (const service of [ProfileService, HostProfileService]) {
    assert.equal(service.method.publishProfile.output.typeName, "clankerbox.v1.ProfileBuild");
    assert.equal(service.method.uploadRecipe.methodKind, "unary");
  }
  assert.equal(ProfileService.method.listProfileRevisions.output.typeName, "clankerbox.v1.ListProfileRevisionsResponse");
});
