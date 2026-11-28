import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = join(tmpdir(), `pi-herdsman-test-${process.pid}`);
delete process.env.PI_HERDSMAN_RESTORE_MODEL;
