import { beforeEach, expect, it, vi } from "vitest";
import {
  authenticationDescription,
  decryptAuthentication,
  encryptAuthentication,
} from "../../../../modules/notes/packages/desktop/src/features/agent/main/settings";
const encryption = vi.hoisted(() => ({ available: true }));
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryption.available,
    encryptString: (value: string) => Buffer.from(value).map((byte) => byte ^ 0x5a),
    decryptString: (value: Buffer) =>
      Buffer.from(value)
        .map((byte) => byte ^ 0x5a)
        .toString(),
  },
}));
beforeEach(() => {
  encryption.available = true;
});

it("认证原文只在主进程解密，公开描述与密文不会暴露密钥", () => {
  const auth = { type: "bearer" as const, value: "private-api-secret" };
  const encrypted = encryptAuthentication(auth);
  expect(encrypted).not.toContain(auth.value);
  expect(JSON.stringify(authenticationDescription(auth))).not.toContain(auth.value);
  expect(decryptAuthentication(encrypted)).toEqual(auth);
});

it("系统加密不可用时拒绝凭据，无认证不依赖系统加密", () => {
  encryption.available = false;
  expect(() => encryptAuthentication({ type: "bearer", value: "secret" })).toThrow("安全存储");
  expect(encryptAuthentication({ type: "none" })).toBeNull();
  expect(decryptAuthentication(null)).toEqual({ type: "none" });
});

it("损坏认证的异常不带解密原文，避免 JSON 解析错误泄露认证材料", () => {
  const encrypted = Buffer.from("private-invalid-secret")
    .map((byte) => byte ^ 0x5a)
    .toString("base64");
  expect(() => decryptAuthentication(encrypted)).toThrow("认证格式");
});
