import Anthropic from '@anthropic-ai/sdk';

export interface JudgeConfig {
  aspects: string[];
  minimumScore: number;
}

export interface JudgeResult {
  overallScore: number;
  aspectScores: Record<string, number>;
  similarities: string[];
  differences: string[];
  suggestions: string[];
}

type ContentBlock = { type: 'text'; text: string } | {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/png'; data: string };
};

/**
 * Uses Claude vision to compare original game screenshots against remake screenshots.
 * Follows the pattern from llm-sanity.spec.ts.
 */
export class LlmJudge {
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : undefined);
  }

  async compare(
    originalScreenshots: Buffer[],
    remakeScreenshots: Buffer[],
    scenarioName: string,
    scenarioDescription: string,
    config: JudgeConfig,
  ): Promise<JudgeResult> {
    console.log(`[Judge] Comparing ${originalScreenshots.length} original vs ${remakeScreenshots.length} remake screenshots`);

    const originalBlocks = buildImageBlocks('ORIGINAL GAME', originalScreenshots);
    const remakeBlocks = buildImageBlocks('WEB REMAKE', remakeScreenshots);
    const aspectList = config.aspects.map(a => `  - ${a}`).join('\n');

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          ...originalBlocks,
          ...remakeBlocks,
          {
            type: 'text',
            text: `You are comparing screenshots from the ORIGINAL Emperor: Battle for Dune (2001 PC game) with a WEB REMAKE of the same game.

Scenario: ${scenarioName}
Description: ${scenarioDescription}

Please evaluate the visual similarity between the original and the remake.

Rate the following aspects on a scale of 1-10 (1=completely different, 10=nearly identical):
${aspectList}

Also rate the OVERALL visual similarity from 1-10.

Reply with ONLY valid JSON in this exact format:
{
  "overallScore": <number 1-10>,
  "aspectScores": { ${config.aspects.map(a => `"${a}": <number>`).join(', ')} },
  "similarities": ["<what matches well>", "..."],
  "differences": ["<notable divergence>", "..."],
  "suggestions": ["<improvement idea>", "..."]
}

Be fair but generous — this is a web browser remake of a 2001 DirectX game, so pixel-perfect matching is not expected. Focus on whether the remake captures the spirit and layout of the original.`,
          },
        ],
      }],
    });

    return this.parseAndValidate(response);
  }

  /**
   * Judge remake screenshots alone (when no original screenshots are available).
   * Rates how much the screenshots look like the original game based on the LLM's knowledge.
   */
  async judgeRemakeOnly(
    remakeScreenshots: Buffer[],
    scenarioName: string,
    scenarioDescription: string,
    config: JudgeConfig,
  ): Promise<JudgeResult> {
    console.log(`[Judge] Rating ${remakeScreenshots.length} remake screenshots (no original available)`);

    const remakeBlocks = buildImageBlocks('WEB REMAKE', remakeScreenshots);
    const aspectList = config.aspects.map(a => `  - ${a}`).join('\n');

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          ...remakeBlocks,
          {
            type: 'text',
            text: `You are evaluating screenshots from a WEB REMAKE of Emperor: Battle for Dune (2001 PC RTS game by Intelligent Games / Westwood Studios).

Scenario: ${scenarioName}
Description: ${scenarioDescription}

Based on your knowledge of the original game, rate how faithfully this web remake captures the visual style and layout of the original.

Rate the following aspects on a scale of 1-10 (1=completely wrong, 10=very faithful):
${aspectList}

Also rate the OVERALL visual faithfulness from 1-10.

Reply with ONLY valid JSON in this exact format:
{
  "overallScore": <number 1-10>,
  "aspectScores": { ${config.aspects.map(a => `"${a}": <number>`).join(', ')} },
  "similarities": ["<what matches the original well>", "..."],
  "differences": ["<notable divergence from original>", "..."],
  "suggestions": ["<improvement idea>", "..."]
}

Be fair but generous — this is a web browser remake, so pixel-perfect matching is not expected.`,
          },
        ],
      }],
    });

    return this.parseAndValidate(response);
  }

  private parseAndValidate(response: Anthropic.Message): JudgeResult {
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    console.log('[Judge] Raw response:', text);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM judge did not return valid JSON');
    }

    const result: JudgeResult = JSON.parse(jsonMatch[0]);

    if (typeof result.overallScore !== 'number' || result.overallScore < 1 || result.overallScore > 10) {
      throw new Error(`Invalid overallScore: ${result.overallScore}`);
    }

    console.log(`[Judge] Overall score: ${result.overallScore}/10`);
    for (const [aspect, score] of Object.entries(result.aspectScores)) {
      console.log(`[Judge]   ${aspect}: ${score}/10`);
    }

    return result;
  }
}

function buildImageBlocks(label: string, screenshots: Buffer[]): ContentBlock[] {
  return screenshots.flatMap((buf, i) => [
    {
      type: 'text' as const,
      text: `${label} — Screenshot ${i + 1}:`,
    },
    {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png' as const,
        data: buf.toString('base64'),
      },
    },
  ]);
}
