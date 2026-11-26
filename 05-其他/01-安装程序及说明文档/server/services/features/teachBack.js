/**
 * 12.4 Teach-back 2.0 诊后回授
 * ---------------------------------------------------------
 * 记录医生原话 → 生成 3–5 道单选题 → 核对患者是否听懂。
 * 安全：只核对医生原话；不生成药名剂量；答错两次建议问医生 / 药师。
 */
const { nowIso, newId } = require('../../db');

const FREQ = /((?:一天|每天|每日)\s*(?:一次|两次|三次|1\s*次|2\s*次|3\s*次))/;
const TIMING = /(饭前|饭后|随餐|睡前|早上|晚上|空腹)/;
const DURATION = /((?:\d+|[一二三四五六七八九十])\s*(?:天|周|个月))/;
const FOLLOWUP = /(复诊|复查|再来看|回来看看|门诊)/;
const WARNING = /(出血|发烧|发热|疼痛加重|加重|不舒服)/;

function safeJson(text, fallback) {
  try { const v = JSON.parse(text); return v == null ? fallback : v; } catch (e) { return fallback; }
}

function createTeachBackService(db, cases) {
  function buildQuestions(instruction) {
    const text = String(instruction || '').slice(0, 500);
    const questions = [];
    const add = (id, q, options, correct) => {
      if (questions.length >= 5) return;
      /* 选项去重，保证「正确答案」一定在选项里且不重复 */
      const opts = [];
      [correct].concat(options || []).forEach(o => {
        const v = String(o == null ? '' : o).trim();
        if (v && !opts.includes(v) && opts.length < 4) opts.push(v);
      });
      if (!opts.includes('说不清')) opts.push('说不清');
      questions.push({ id, text: q, options: opts, correct });
    };

    const freq = text.match(FREQ);
    if (freq) {
      add('freq', '医生说的吃药次数是？', [freq[1], '一天两次', '说不清'], freq[1]);
    }
    const timing = text.match(TIMING);
    if (timing) {
      add('timing', '医生说的吃药时间是？', [timing[1], '饭前', '饭后', '说不清'], timing[1]);
    }
    const duration = text.match(DURATION);
    if (duration) {
      add('duration', '医生说这个要持续多久？', [duration[1], '一直吃', '说不清'], duration[1]);
    }
    if (FOLLOWUP.test(text)) {
      add('followup', '医生有没有说需要复诊？', ['需要复诊', '不需要', '说不清'], '需要复诊');
    }
    if (WARNING.test(text)) {
      add('warning', '医生有没有说出现什么情况要回来？', ['说了', '没说', '说不清'], '说了');
    }
    if (/检查|化验|拍片|B 超|CT/i.test(text)) {
      add('exam', '医生有没有说要做检查？', ['要做检查', '不用检查', '说不清'], '要做检查');
    }

    while (questions.length < 3) {
      const id = 'generic' + questions.length;
      add(id, '医生说的话，你听清楚了吗？', ['听清了', '没听清', '说不清'], '听清了');
    }
    return questions;
  }

  function create(caseId, sessionId, payload) {
    const owned = cases.getOwned(caseId, sessionId);
    if (!owned) return { error: 'NOT_FOUND' };
    const instruction = String((payload && payload.instruction) || '').trim();
    if (!instruction) return { error: 'BAD_REQUEST', message: '请先填写医生原话' };

    const questions = buildQuestions(instruction);
    const id = newId('tb');
    db.prepare('INSERT INTO teachback_sessions (id, case_id, instruction_json, answers_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, caseId, JSON.stringify({ text: instruction, questions }), '[]', 'open', nowIso());

    return {
      data: {
        id,
        status: 'open',
        instruction,
        questions: questions.map(q => ({ id: q.id, text: q.text, options: q.options }))
      }
    };
  }

  function answer(sessionId, teachbackId, payload) {
    const row = db.prepare('SELECT * FROM teachback_sessions WHERE id = ?').get(teachbackId);
    if (!row) return { status: 404, error: 'NOT_FOUND' };
    const owned = cases.getOwned(row.case_id, sessionId);
    if (!owned) return { status: 404, error: 'NOT_FOUND' };

    const instruction = safeJson(row.instruction_json, { questions: [] });
    const answers = Array.isArray(payload && payload.answers) ? payload.answers : [];
    const results = [];
    let wrong = 0;

    (instruction.questions || []).forEach(q => {
      const given = answers.find(a => a && a.id === q.id);
      if (!given) return;
      const ok = given.selected === q.correct;
      if (!ok) wrong += 1;
      results.push({ id: q.id, text: q.text, selected: given.selected, correct: q.correct, ok });
    });

    if (!results.length) return { status: 400, error: 'BAD_REQUEST' };

    const status = wrong === 0 ? 'consistent' : 'inconsistent';
    db.prepare('UPDATE teachback_sessions SET answers_json = ?, status = ? WHERE id = ?')
      .run(JSON.stringify(answers), status, teachbackId);

    return {
      status: 200,
      data: {
        id: teachbackId,
        status,
        results,
        wrongCount: wrong,
        advice: wrong === 0
          ? '复述和医生原话一致。'
          : (wrong >= 2
            ? '有两处以上不一致，建议再问一次医生或药师，确认清楚再执行。'
            : '有一处不一致，建议当场向医生确认。')
      }
    };
  }

  return { create, answer, buildQuestions };
}

module.exports = { createTeachBackService };
