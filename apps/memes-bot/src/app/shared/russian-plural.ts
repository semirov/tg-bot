/**
 * Три формы русского слова, выбираемые по числу:
 * `[одна (1, 21, 31…), две–четыре (2–4, 22–24…), пять и более (0, 5–20, 25–30…)]`.
 */
export type RussianPluralForms = readonly [one: string, few: string, many: string];

/**
 * Выбирает правильную форму русского слова по количеству.
 *
 * Соблюдает правило 11–14: при таких окончаниях всегда берётся форма «много»,
 * например `pluralizeRu(11, ['год', 'года', 'лет']) === 'лет'`.
 *
 * @param count количество (целое число)
 * @param forms три формы: для 1, для 2–4 и для 5+, например `['год', 'года', 'лет']`
 * @returns одна из переданных форм
 */
export function pluralizeRu(count: number, forms: RussianPluralForms): string {
  const lastDigit = count % 10;
  const lastTwoDigits = count % 100;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
    return forms[2];
  }

  if (lastDigit === 1) {
    return forms[0];
  }

  if (lastDigit >= 2 && lastDigit <= 4) {
    return forms[1];
  }

  return forms[2];
}
