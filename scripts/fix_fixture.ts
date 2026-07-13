import fs from 'fs';
import path from 'path';
import { Evaluator } from '../src/lib/evaluation/evaluator';

const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'reviews', '2026', '07', 'fixture-product', 'review.json');
const rawReview = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

// Fix some manual scores to match the required expected scores if necessary
// But actually, just recalculating it should be enough if the scores are matching the ones from the test, wait the test modified the scores in-memory.
// If I want the fixture to have Jury Score: 81.8 (as in the prompt), let's just let it recalculate as is.
// Actually, in the prompt: "Alex: 80, David: 85, Lisa: 90, Sarah: 74, Marcus: 80, Jury Score: 81.8"
// Let's modify the scores in the fixture to match those exactly if they don't already.

const evaluator = new Evaluator();
const recalculated = evaluator.recalculateScores(rawReview.evaluation);

rawReview.evaluation = recalculated;
rawReview.jury_score = recalculated.recalculated_jury_score;
rawReview.judge_score_range = recalculated.judge_score_range;

fs.writeFileSync(fixturePath, JSON.stringify(rawReview, null, 2) + '\n');
console.log('Fixture fixed. Jury Score:', rawReview.jury_score);
