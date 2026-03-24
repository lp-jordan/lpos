import fs from 'node:fs/promises';
import path from 'node:path';

const runtimeRoot = process.env.LPOS_RUNTIME_DIR?.trim() || path.join(process.cwd(), 'runtime');

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copyDirectoryContents(sourceDir, targetDir) {
  await ensureDir(targetDir);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, targetPath);
    } else {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

async function stageDirectory(label, sourceDir, targetDir) {
  if (!sourceDir) {
    console.log(`[lpos-runtime] ${label}: no source configured, leaving ${targetDir} untouched.`);
    return;
  }

  if (!(await pathExists(sourceDir))) {
    throw new Error(`[lpos-runtime] ${label}: source directory not found: ${sourceDir}`);
  }

  await copyDirectoryContents(sourceDir, targetDir);
  console.log(`[lpos-runtime] ${label}: staged from ${sourceDir} to ${targetDir}`);
}

await ensureDir(runtimeRoot);

await stageDirectory(
  'Whisper runtime',
  process.env.LPOS_STAGE_WHISPER_RUNTIME_FROM?.trim(),
  path.join(runtimeRoot, 'whisper-runtime'),
);

await stageDirectory(
  'Whisper models',
  process.env.LPOS_STAGE_WHISPER_MODELS_FROM?.trim(),
  path.join(runtimeRoot, 'whisper-models'),
);

await stageDirectory(
  'ATEM bridge',
  process.env.LPOS_STAGE_ATEM_BRIDGE_FROM?.trim(),
  path.join(runtimeRoot, 'atem-bridge'),
);
