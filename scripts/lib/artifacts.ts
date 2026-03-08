import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Abi, Hex } from "viem";

export interface HardhatArtifact {
  abi: Abi;
  bytecode: Hex;
  contractName: string;
}

export async function readArtifact(
  sourceName: string,
  contractName: string
): Promise<HardhatArtifact> {
  const artifactPath = join(process.cwd(), "artifacts", sourceName, `${contractName}.json`);
  const raw = await readFile(artifactPath, "utf8");
  const parsed = JSON.parse(raw) as {
    abi: Abi;
    bytecode: Hex;
    contractName: string;
  };

  return {
    abi: parsed.abi,
    bytecode: parsed.bytecode,
    contractName: parsed.contractName
  };
}

