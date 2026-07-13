import * as fs from 'fs';
import * as path from 'path';
import {
  JUDGE_SLUGS,
  JudgeProfileSchema,
  RubricCriterionSchema,
  type JudgeProfile,
  type JudgeSlug,
  type RubricCriterion,
} from '../schemas/jury';

const HACKATHON_PATH = path.join(process.cwd(), 'templates', 'hackathon.json');

let cachedJudges: JudgeProfile[] | null = null;
let cachedRubric: RubricCriterion[] | null = null;

function loadRaw(): { personas: any[]; criteria: any[] } {
  const raw = JSON.parse(fs.readFileSync(HACKATHON_PATH, 'utf8'));
  return { personas: raw.personas, criteria: raw.criteria };
}

// --- Prompt section parser ---

function extractSection(prompt: string, header: string): string {
  const pattern = new RegExp(`\\[${header}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\[|$)`);
  const match = prompt.match(pattern);
  if (!match) {
    throw new Error(`Required section [${header}] not found in persona prompt.`);
  }
  return match[1].trim();
}

function parseGuidingPrinciples(section: string): { loves: string[]; hates: string[] } {
  const lovesMatch = section.match(/You love:\s*([\s\S]*?)(?=You hate:|$)/i);
  const hatesMatch = section.match(/You hate:\s*([\s\S]*?)$/i);
  if (!lovesMatch) throw new Error('Guiding Principles missing "You love:" section.');
  if (!hatesMatch) throw new Error('Guiding Principles missing "You hate:" section.');

  const parseBullets = (text: string): string[] =>
    text
      .split('\n')
      .map(line => line.replace(/^[-•*]\s*/, '').trim())
      .filter(line => line.length > 0 && !line.startsWith('You '));

  return {
    loves: parseBullets(lovesMatch[1]),
    hates: parseBullets(hatesMatch[1]),
  };
}

function parseEvaluationFramework(section: string): Array<{ label: string; question: string }> {
  const lines = section.split('\n').map(l => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
  const lenses: Array<{ label: string; question: string }> = [];
  for (const line of lines) {
    const match = line.match(/^(\w[\w\s&]*?):\s*(.+)$/);
    if (match) {
      lenses.push({ label: match[1].trim(), question: match[2].trim() });
    }
  }
  if (lenses.length === 0) {
    throw new Error('Evaluation Framework produced no lenses.');
  }
  return lenses;
}

function parseExpertise(section: string): string[] {
  return section
    .split(/[,\n]/)
    .map(s => s.replace(/^[-•*]\s*/, '').replace(/\band\b/g, '').trim())
    .filter(s => s.length > 0);
}

function slugFromName(name: string): JudgeSlug {
  const slug = name.toLowerCase() as JudgeSlug;
  if (!JUDGE_SLUGS.includes(slug)) {
    throw new Error(`Unknown judge name: ${name}. Expected one of ${JUDGE_SLUGS.join(', ')}.`);
  }
  return slug;
}

// --- Public API ---

export function getJudges(): JudgeProfile[] {
  if (cachedJudges) return cachedJudges;

  const { personas } = loadRaw();

  if (personas.length !== 5) {
    throw new Error(`Expected 5 personas, got ${personas.length}.`);
  }

  const names = new Set(personas.map((p: any) => p.name));
  if (names.size !== 5) {
    throw new Error('Duplicate persona names detected.');
  }

  const judges: JudgeProfile[] = personas.map((p: any) => {
    if (!p.name || !p.role) {
      throw new Error(`Persona missing name or role: ${JSON.stringify(p)}`);
    }
    const slug = slugFromName(p.name);

    // Verify avatar file exists
    const avatarFile = path.join(process.cwd(), 'public', 'avatars', `${slug}.jpg`);
    if (!fs.existsSync(avatarFile)) {
      throw new Error(`Avatar file not found: ${avatarFile}`);
    }

    const prompt: string = p.prompt;
    const background = extractSection(prompt, 'Core Identity & Background');
    const personalityAndTone = extractSection(prompt, 'Personality & Tone');
    const expertiseRaw = extractSection(prompt, 'Specialized Expertise');
    const guidingPrinciples = extractSection(prompt, 'Guiding Principles');
    const evalFramework = extractSection(prompt, 'Evaluation Framework');

    const { loves, hates } = parseGuidingPrinciples(guidingPrinciples);
    const evaluationLenses = parseEvaluationFramework(evalFramework);
    const expertise = parseExpertise(expertiseRaw);

    const profile = {
      sourceId: p.id,
      slug,
      name: p.name,
      role: p.role,
      avatarPath: `/avatars/${slug}.jpg`,
      background,
      personalityAndTone,
      expertise,
      loves,
      hates,
      evaluationLenses,
    };

    return JudgeProfileSchema.parse(profile);
  });

  cachedJudges = judges;
  return judges;
}

export function getJudge(slug: JudgeSlug): JudgeProfile {
  const judges = getJudges();
  const judge = judges.find(j => j.slug === slug);
  if (!judge) {
    throw new Error(`Judge not found: ${slug}`);
  }
  return judge;
}

export function getRubric(): RubricCriterion[] {
  if (cachedRubric) return cachedRubric;

  const { criteria } = loadRaw();

  if (criteria.length !== 6) {
    throw new Error(`Expected 6 criteria, got ${criteria.length}.`);
  }

  const totalWeight = criteria.reduce((sum: number, c: any) => sum + c.weight, 0);
  if (totalWeight !== 100) {
    throw new Error(`Criteria weights must sum to 100, got ${totalWeight}.`);
  }

  const rubric: RubricCriterion[] = criteria.map((c: any) => {
    const desc: string = c.description;

    // Parse "What judges evaluate:" section
    const evalMatch = desc.match(/What judges evaluate:\s*\n([\s\S]*?)(?=\nSignals of a strong submission:|$)/i);
    if (!evalMatch) {
      throw new Error(`Criterion "${c.name}" missing "What judges evaluate:" section.`);
    }

    // Parse "Signals of a strong submission:" section
    const signalsMatch = desc.match(/Signals of a strong submission:\s*\n([\s\S]*?)$/i);
    if (!signalsMatch) {
      throw new Error(`Criterion "${c.name}" missing "Signals of a strong submission:" section.`);
    }

    const parseBullets = (text: string): string[] =>
      text
        .split('\n')
        .map(line => line.replace(/^[-•*]\s*/, '').trim())
        .filter(line => line.length > 0);

    const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');

    const criterion = {
      slug,
      name: c.name,
      weight: c.weight,
      whatJudgesEvaluate: parseBullets(evalMatch[1]),
      strongSignals: parseBullets(signalsMatch[1]),
    };

    return RubricCriterionSchema.parse(criterion);
  });

  cachedRubric = rubric;
  return rubric;
}
