import assert from "node:assert/strict";
import test from "node:test";
import {
  appendProviderDetail,
  readBoundedJsonObject,
  safeDiagnosticText,
} from "./internal/provider-http-safety.mjs";

test("bounded provider error reader accepts only small JSON objects", async () => {
  assert.deepEqual(
    await readBoundedJsonObject(
      new Response(JSON.stringify({ message: "capacity unavailable" }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    ),
    { message: "capacity unavailable" },
  );

  for (const response of [
    new Response("not json", { headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify(["array"]), {
      headers: { "content-type": "application/json" },
    }),
    new Response(JSON.stringify({ message: "x".repeat(5_000) }), {
      headers: { "content-type": "application/json" },
    }),
    new Response(JSON.stringify({ message: "looks valid" }), {
      headers: { "content-type": "text/html" },
    }),
  ]) {
    assert.equal(await readBoundedJsonObject(response), undefined);
  }
});

test("safe provider diagnostics reject credential and secret-like controlled text", () => {
  const credential = "fixture-live-credential";
  const unsafe = [
    `provider echoed ${credential}`,
    "<html>gateway failure</html>",
    "-----BEGIN OPENSSH PRIVATE KEY----- abc",
    "Authorization: Bearer abc",
    "bearer=abc",
    "api_key: abc",
    "api-key = abc",
    "token: abc",
    "password=abc",
    "secret: abc",
    "private_key=abc",
  ];
  for (const value of unsafe) {
    assert.equal(safeDiagnosticText(value, credential), undefined, value);
  }
  assert.equal(safeDiagnosticText({ message: "not a string" }, credential), undefined);
  assert.equal(safeDiagnosticText("   \n\t ", credential), undefined);
});

test("safe provider diagnostics normalize and bound benign messages", () => {
  const credential = "fixture-live-credential";
  assert.equal(
    safeDiagnosticText("  Capacity   is\nnot available in this region.  ", credential),
    "Capacity is not available in this region.",
  );

  const bounded = safeDiagnosticText("x".repeat(300), credential);
  assert.equal(bounded?.length, 240);
  assert.equal(bounded?.endsWith("..."), true);
  assert.equal(
    appendProviderDetail("Provider rejected the request", bounded),
    `Provider rejected the request: ${bounded}`,
  );
  assert.equal(
    appendProviderDetail("Provider rejected the request", undefined),
    "Provider rejected the request",
  );
});
