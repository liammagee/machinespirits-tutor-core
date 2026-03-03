import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const promptPath = resolve(__dirname, '..', '..', 'prompts', 'learner-unified.md');
const prompt = readFileSync(promptPath, 'utf-8');

describe('learner-unified prompt contract', () => {
  it('does not require legacy INTERNAL/EXTERNAL output labels', () => {
    expect(prompt).not.toMatch(/^\[INTERNAL\]:/m);
    expect(prompt).not.toMatch(/^\[EXTERNAL\]:/m);
    expect(prompt).not.toMatch(/^Format:\s*$/m);
  });

  it('requires only the learner\'s outward reply', () => {
    expect(prompt).toMatch(/Respond with ONLY what the learner would actually say out loud to the tutor/i);
  });

  it('forbids think blocks in the visible output', () => {
    expect(prompt).toMatch(/Do NOT emit `<think>\.\.\.<\/think>` blocks\./i);
  });
});
