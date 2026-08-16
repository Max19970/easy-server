import type { HostTrustRequiredError } from "@easyai101/easyserver-plugin-sdk";

export interface SshHostTrustEvidence {
  readonly target: {
    readonly host: string;
    readonly port: number;
  };
  readonly key: {
    readonly type: string;
    readonly fingerprint: string;
  };
}

export function sshHostTrustEvidence(
  trust: HostTrustRequiredError,
): SshHostTrustEvidence {
  return {
    target: {
      host: trust.host,
      port: trust.port,
    },
    key: {
      type: trust.keyType,
      fingerprint: trust.fingerprint,
    },
  };
}
