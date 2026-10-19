import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { exportIdentity, importIdentity, newIdentity, type Identity } from "../src/lib/ootle";

export function loadOrCreate(name: string): Identity {
  mkdirSync(".local", { recursive: true });
  const path = `.local/${name}.key`;
  if (existsSync(path)) return importIdentity(readFileSync(path, "utf8").trim());
  const id = newIdentity();
  writeFileSync(path, exportIdentity(id), { mode: 0o600 });
  return id;
}

if (process.argv[1]?.endsWith("identity.ts")) {
  for (const name of process.argv.slice(2)) {
    const id = loadOrCreate(name);
    console.log(`${name} ${id.ownerAddress}`);
  }
}
