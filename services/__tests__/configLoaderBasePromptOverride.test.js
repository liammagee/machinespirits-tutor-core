import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPromptLoader } from '../configLoaderBase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROMPTS_DIR = path.resolve(__dirname, '..', '..', 'prompts');
const PROMPTS_DIR_OVERRIDE_ENV = 'MACHINESPIRITS_PROMPTS_DIR';

function stripPrompt(raw) {
  return raw.replace(/^#[^\n]*\n+/, '').trim();
}

describe('createPromptLoader prompt directory override', () => {
  const originalOverride = process.env[PROMPTS_DIR_OVERRIDE_ENV];

  afterEach(() => {
    if (originalOverride == null) {
      delete process.env[PROMPTS_DIR_OVERRIDE_ENV];
    } else {
      process.env[PROMPTS_DIR_OVERRIDE_ENV] = originalOverride;
    }
  });

  it('loads matching files from the override prompts directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-override-'));
    const overridePath = path.join(tempDir, 'tutor-ego.md');
    fs.writeFileSync(
      overridePath,
      '# Override Prompt\n<!-- version: 9.9 -->\nUse the override prompt content.\n',
      'utf8',
    );
    process.env[PROMPTS_DIR_OVERRIDE_ENV] = tempDir;

    const loader = createPromptLoader();
    const prompt = loader.loadPrompt('tutor-ego.md');
    const metadata = loader.getPromptMetadata('tutor-ego.md');
    const status = loader.getPromptCacheStatus()['tutor-ego.md'];

    expect(prompt).toBe('<!-- version: 9.9 -->\nUse the override prompt content.');
    expect(metadata.version).toBe('9.9');
    expect(status.path).toBe(overridePath);
  });

  it('falls back to the canonical prompts directory for missing override files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-override-'));
    process.env[PROMPTS_DIR_OVERRIDE_ENV] = tempDir;

    const loader = createPromptLoader();
    const prompt = loader.loadPrompt('tutor-superego.md');
    const expected = stripPrompt(fs.readFileSync(path.join(PROMPTS_DIR, 'tutor-superego.md'), 'utf8'));
    const status = loader.getPromptCacheStatus()['tutor-superego.md'];

    expect(prompt).toBe(expected);
    expect(status.path).toBe(path.join(PROMPTS_DIR, 'tutor-superego.md'));
  });
});
