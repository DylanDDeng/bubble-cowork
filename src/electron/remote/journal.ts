import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import type { CommandResult } from "../../shared/remote/protocol";
export interface RemoteConfig {
  relay: string;
  room: string;
  routeToken: string;
  registrationToken: string;
  identity: string;
  peerId: string;
  projectIds: string[];
  enabled: boolean;
}
export interface RemoteDevice {
  peerId: string;
  name: string;
  pairedAt: number;
}
interface Entry {
  fingerprint: string;
  result: CommandResult;
  expiresAt: number;
}
export interface JournalState {
  config?: RemoteConfig;
  devices: RemoteDevice[];
  commands: Record<string, Entry>;
}
/** Atomic replace, fsync before ack; secrets are encrypted by the endpoint key store. */
export class RemoteJournal {
  state: JournalState;
  constructor(
    private file: string,
    private encode: (data: string) => string,
    private decode: (data: string) => string,
  ) {
    this.state = existsSync(file)
      ? JSON.parse(decode(readFileSync(file, "utf8")))
      : { devices: [], commands: {} };
    this.update((draft) => {
      for (const entry of Object.values(draft.commands))
        if (entry.result.state === "accepted") entry.result.state = "unknown";
    });
  }
  update(change: (draft: JournalState) => void) {
    const draft = structuredClone(this.state);
    change(draft);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const fd = openSync(this.file + ".tmp", "w", 0o600);
    try {
      writeFileSync(fd, this.encode(JSON.stringify(draft)));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(this.file + ".tmp", this.file);
    const directory = openSync(dirname(this.file), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    this.state = draft;
  }
}
