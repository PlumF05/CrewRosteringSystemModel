/**
 * Read-only probes for the legacy TypeScript scheduling implementation.
 * Run from an installed checkout: node docs/plans/audit-baseline.mjs
 * No production data, database, workbook, or application source is modified.
 * Exit code 0 means the probes executed, not that every observation is correct.
 * The JSON deliberately records defects rather than asserting defects as desired behavior.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function compile(relativePath, replacements = {}) {
  let js = ts.transpileModule(readFileSync(resolve(root, relativePath), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: relativePath,
  }).outputText;
  for (const [specifier, url] of Object.entries(replacements)) {
    js = js.replaceAll("'" + specifier + "'", JSON.stringify(url));
    js = js.replaceAll('"' + specifier + '"', JSON.stringify(url));
  }
  const url = 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
  return url;
}
const weekUrl = compile('src/utils/weekParser.ts');
const sectionUrl = compile('src/utils/sectionOrder.ts');
const typesUrl = compile('src/algorithms/types.ts');
const shared = { '../utils/weekParser': weekUrl, '../utils/sectionOrder': sectionUrl, './types': typesUrl };
const greedy = await import(compile('src/algorithms/greedy.ts', shared));
const conflicts = await import(compile('src/algorithms/dutyConflict.ts', shared));
const types = await import(typesUrl);

const assistant = (id) => ({ id, name: 'Synthetic-' + id, identity: 'undergrad' });
const rules = (patch = {}) => ({
  ...structuredClone(types.DEFAULT_RULES),
  weekStart: 1, weekEnd: 1, workdays: [1],
  workSections: [{ start: 1, end: 1, label: '上午' }],
  minSectionsPerAssistant: 0, maxSectionsPerAssistant: 2,
  minPerSlot: 1, maxPerSlot: 1, minConsecutiveSections: 1,
  balanceDaily: false, ...patch,
});
const observations = [];
const course = { assistantId: 1, kind: 'theory', dayOfWeek: 1, sectionText: '第一节', weekRanges: [[1, 1]] };
const locked = { dayOfWeek: 1, slotKey: 'c1', assistantId: 1 };

const collisionInput = { weekNo: 1, rules: rules(), assistants: [assistant(1)], courses: [course], keep: [locked] };
const collision = greedy.scheduleOneWeek(collisionInput);
observations.push({ id: 'P01', issue: 'keep accepts a course-conflicting assignment', input: collisionInput,
  findingObserved: collision.assignments.some((x) => x.assistantId === 1 && x.slotKey === 'c1'),
  output: collision.assignments });

const capacityInput = { weekNo: 1, rules: rules(), assistants: [assistant(1), assistant(2)], courses: [],
  keep: [locked, { ...locked, assistantId: 2 }] };
const capacity = greedy.scheduleOneWeek(capacityInput);
observations.push({ id: 'P02', issue: 'keep can exceed maxPerSlot', input: capacityInput,
  findingObserved: capacity.assignments.length > capacityInput.rules.maxPerSlot, output: capacity.assignments });

const movedInput = { weekNo: 1, rules: rules({ workdays: [1, 2], workSections: [{ start: 1, end: 2, label: '上午' }],
  maxSectionsPerAssistant: 1, balanceDaily: true }), assistants: [assistant(1), assistant(2)], courses: [],
  keep: [locked, { dayOfWeek: 1, slotKey: 'c2', assistantId: 2 }] };
const moved = greedy.scheduleOneWeek(movedInput);
const lost = movedInput.keep.filter((k) => !moved.assignments.some((a) => a.assistantId === k.assistantId &&
  a.dayOfWeek === k.dayOfWeek && a.slotKey === k.slotKey && a.source === 'manual'));
observations.push({ id: 'P03', issue: 'daily balancing can move a kept manual entry and change its source', input: movedInput,
  findingObserved: lost.length > 0, lost, output: moved.assignments });

const repeatedInput = { rules: rules({ weekEnd: 2 }), assistants: [assistant(1)], courses: [], keep: [locked] };
const repeated = greedy.scheduleAll(repeatedInput);
observations.push({ id: 'P04', issue: 'keep has no week scope and is applied in every scheduled week', input: repeatedInput,
  scope: 'Requires a caller intending the retained entry for week 1; API itself has no week field.',
  findingObserved: repeated.every((w) => w.assignments.some((a) => a.source === 'manual')),
  output: repeated.map((w) => ({ weekNo: w.weekNo, assignments: w.assignments })) });

const unknown = { ...course, courseName: 'Synthetic unknown section', sectionText: '未知节次' };
const unknownInput = { weekNo: 1, rules: rules(), assistants: [assistant(1)], courses: [unknown] };
const unknownSchedule = greedy.scheduleOneWeek(unknownInput);
const unknownConflicts = conflicts.findDutyConflicts({ rules: unknownInput.rules, assistantId: 1, courses: [unknown],
  duties: [{ id: 1, weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: 1 }] });
observations.push({ id: 'P05', issue: 'unknown section has different scheduling and conflict-report semantics', input: unknownInput,
  findingObserved: unknownSchedule.assignments.length === 0 && unknownConflicts.length === 0,
  output: { assignments: unknownSchedule.assignments, conflicts: unknownConflicts },
  note: 'This is a documented policy inconsistency; the new system should return an explicit unknown/review state.' });

const invalid = rules({ minSectionsPerAssistant: -2, maxSectionsPerAssistant: -1,
  minPerSlot: -2, maxPerSlot: -1, workdays: [0, 8], workSections: [{ start: 1.5, end: 2.5, label: 'invalid' }] });
const issues = types.validateRules(invalid);
observations.push({ id: 'P06', issue: 'rule validation accepts negative limits, invalid weekdays and fractional sections',
  input: invalid, findingObserved: issues.length === 0, output: issues });

const custom = rules({ workSections: [{ start: 8, end: 11, label: 'custom' }] });
const normalized = types.normalizeRules(custom);
observations.push({ id: 'P07', issue: 'value-based legacy normalization also rewrites a custom 8-11 range', input: custom,
  findingObserved: normalized.workSections[0].start === 6 && normalized.workSections[0].end === 9,
  output: normalized.workSections,
  note: 'The old default and a deliberate custom range are indistinguishable without a schema/version marker.' });

const shortInput = { weekNo: 1, rules: rules({ workSections: [{ start: 1, end: 4, label: '上午' }],
  minSectionsPerAssistant: 3, maxSectionsPerAssistant: 3, minConsecutiveSections: 2 }),
  assistants: [assistant(1), assistant(2)], courses: [] };
const shortOutput = greedy.scheduleOneWeek(shortInput);
const fixedShortObserved = shortInput.assistants.some((a) => {
  const count = shortOutput.assignments.filter((x) => x.assistantId === a.id).length;
  return count > 0 && count < shortInput.rules.minConsecutiveSections;
});

// A small, deterministic search checks a final-output invariant independently of the allocator.
let seed = 20261026;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
let shortRunCase = null;
for (let n = 0; n < 2000 && !shortRunCase; n++) {
  const people = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, i) => assistant(i + 1));
  const minHours = 1 + Math.floor(random() * 4);
  const r = rules({ workdays: [1, 2], workSections: [{ start: 1, end: 4, label: '上午' }],
    minSectionsPerAssistant: minHours, maxSectionsPerAssistant: minHours + Math.floor(random() * 3),
    maxPerSlot: 1 + Math.floor(random() * 2), minConsecutiveSections: 2 + Math.floor(random() * 2) });
  const courses = [];
  for (const a of people) for (const day of r.workdays) for (let sec = 1; sec <= 4; sec++) {
    if (random() < 0.25) courses.push({ assistantId: a.id, kind: 'theory', dayOfWeek: day,
      sectionText: '第' + sec + '节', weekRanges: [[1, 1]] });
  }
  const input = { weekNo: 1, rules: r, assistants: people, courses };
  const out = greedy.scheduleOneWeek(input);
  for (const a of people) for (const day of r.workdays) {
    const secs = out.assignments.filter((x) => x.assistantId === a.id && x.dayOfWeek === day)
      .map((x) => Number(x.slotKey.slice(1))).sort((x, y) => x - y);
    let len = 0;
    for (let i = 0; i <= secs.length; i++) {
      if (i < secs.length && (i === 0 || secs[i] === secs[i - 1] + 1)) len++;
      else { if (len > 0 && len < r.minConsecutiveSections) shortRunCase = { caseIndex: n, input, assignments: out.assignments }; len = i < secs.length ? 1 : 0; }
    }
  }
}
observations.push({ id: 'P08', issue: 'bounded repair/removal loop may leave a final short auto block',
  findingObserved: fixedShortObserved, input: shortInput, output: shortOutput.assignments,
  searchCasesLimit: 2000, seed: 20261026, searchCounterexample: shortRunCase });

console.log(JSON.stringify({ auditedSourceRevision: '38aaa2b',
  note: 'The script evaluates working-tree files. Check their revision before interpreting results.', observations }, null, 2));
