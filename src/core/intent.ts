/**
 * What the user wants from one message: an answer without any changes ("ничего не трогай", "just answer"),
 * a question (answer it, change only if asked), or a task. Explicit "don't change anything" is enforced
 * (the turn becomes read-only); a plain question only gets a reminder, because "can you fix X?" is a task.
 */

export type Intent = "readonly" | "question" | "task";

const VERB_RU = "(?:трогай|трогать|меняй|менять|правь|править|изменяй|изменять|редактируй|редактировать|переписывай|удаляй)";
/** objects that mean "anything at all", as opposed to "don't touch the tests" (a constraint inside a task) */
const ALL_RU = "(?:ничего|ничо|код|кода|файлы|файлов|файл|проект|исходники|репозиторий|репу)";

const READONLY: RegExp[] = [
  // "ничего не трогай", "ничего не меняй"
  new RegExp(`(?:ничего|ничо)\\s+(?:не\\s+)?(?:надо\\s+|нужно\\s+)?(?:не\\s+)?${VERB_RU}`, "i"),
  // "не трогай ничего / код / файлы", or "не трогай" at the end of a sentence
  new RegExp(`(?:^|[\\s,;.!])не\\s+(?:надо\\s+|нужно\\s+)?${VERB_RU}(?:\\s+${ALL_RU}|\\s*(?:[.!?,;)]|$))`, "i"),
  /без\s+(?:изменений|правок|изменения\s+файлов)/i,
  /(?:^|[\s,;.!])(?:только|просто|лишь)\s+(?:ответь|ответить|посмотри|посмотреть|глянь|прочитай|прочитать|объясни|объяснить|скажи|расскажи|подскажи|проверь\s+и\s+скажи)/i,
  /\bread[- ]?only\b|только\s+чтени/i,
  /\b(?:don'?t|do\s+not|never)\s+(?:change|touch|modify|edit|write)\s+(?:anything|any\s+files?|the\s+code|files?|code)\b/i,
  /\b(?:don'?t|do\s+not)\s+(?:change|touch|modify|edit)\s*(?:[.!?,;)]|$)/i,
  /\bno\s+(?:changes|edits)\b|\bwithout\s+(?:changing|modifying|editing)\b/i,
  /\b(?:just|only)\s+(?:answer|look|explain|tell\s+me|read|check\s+and\s+tell)\b/i,
];

/** Words that ask for a change: a question containing them is a task ("can you fix the bug?") */
const CHANGE =
  /(?:исправ|почин|добав|сделай|создай|напиши|измени|удали|перепиш|реализ|замени|переимен|отрефактор|обнови|поправ|внедри|подключи|настрой|\b(?:fix|add|create|write|implement|change|remove|delete|refactor|update|rename|replace|install|set\s+up)\b)/i;
const QUESTION_START =
  /^\s*(?:как|что|чем|почему|зачем|где|когда|какой|какая|какое|какие|каким|сколько|кто|чей|можно\s+ли|есть\s+ли|нужно\s+ли|правда\s+ли|объясни|расскажи|what|why|how|where|when|which|who|is|are|does|do|did|can|could|should|explain)(?![\p{L}\d])/iu;

export function classifyIntent(text: string): Intent {
  // only the user's own words: not pasted logs or attached files
  const own = text.split(/\n\n(?:<stdin>|Attached by the user with @:)/)[0].trim();
  if (READONLY.some((re) => re.test(own))) return "readonly";
  const firstLine = own.split("\n")[0];
  if ((/\?\s*$/.test(own) || QUESTION_START.test(firstLine)) && !CHANGE.test(own)) return "question";
  return "task";
}

export const READONLY_REMINDER =
  "The user asked you NOT to change anything in this message: only look and answer. Use read-only tools (Read, Grep, Glob, read-only Bash, web, read-only subagents); " +
  "do not edit files or run commands that change anything. If a change seems necessary, describe it and let the user decide.";

export const QUESTION_REMINDER =
  "The user's message is a question. Answer it (read files as needed). Do not edit files or run commands that change anything unless the user explicitly asks for a change; " +
  "if a fix seems useful, describe it and offer it instead.";

export const READONLY_DENIED = (tool: string) =>
  `Not run: ${tool} would change something, and the user asked not to change anything in this message (only look and answer). Answer with what you found; describe any change you would make instead of making it.`;
