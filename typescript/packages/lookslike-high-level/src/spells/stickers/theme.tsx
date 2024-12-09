import { h, behavior, $, select, refer } from "@commontools/common-system";
import { events } from "../../sugar/event.js";
import { defaultTo, Transact } from "../../sugar.js";
import { Reference } from "merkle-reference";

const THEME = "common/theme"
type Theme = {
  font: string,
  accent: string,
  roundness: string,
  borderColor: string,
  borderWidth: string,
  background: string,
}

const defaultTheme = refer({ theme: 'default' })
export const princessTheme: Theme = {
  font: 'Brush Script MT',
  accent: '#FF69B4',
  roundness: '20px',
  borderColor: '#FFC0CB',
  borderWidth: '3px',
  background: '#FFF0F5',
}

export const scienceTheme: Theme = {
  font: 'Courier New',
  accent: '#4169E1',
  borderColor: '#2F4F4F',
  borderWidth: '1px',
  background: '#F0F8FF',
  roundness: '1px',
}

export const wizardTheme: Theme = {
  font: 'Papyrus',
  accent: '#9B59B6',
  roundness: '12px',
  borderColor: '#483D8B',
  borderWidth: '3px',
  background: '#F5F5DC',
}

const princess = refer(princessTheme)

export function applyTheme(self: Reference, theme: Theme) {
  const id = refer(theme)
  return [
    ...Transact.set(id, theme),
    ...Transact.set(self, { [THEME]: id, })
  ]
}
export const resolveTheme = select({
  theme: {
    font: $.font,
    accent: $.accent,
    roundness: $.roundness,
    borderColor: $.borderColor,
    borderWidth: $.borderWidth,
    background: $.background,
  }
})
  .clause(defaultTo($.self, THEME, $.theme, null))
  .clause(defaultTo($.theme, 'font', $.font, 'Times'))
  .clause(defaultTo($.theme, 'accent', $.accent, 'blue'))
  .clause(defaultTo($.theme, 'roundness', $.roundness, '8px'))
  .clause(defaultTo($.theme, 'borderColor', $.borderColor, 'black'))
  .clause(defaultTo($.theme, 'borderWidth', $.borderWidth, '2px'))
  .clause(defaultTo($.theme, 'background', $.background, 'white'))

export const Themeable = (name: string, theme: Theme) => behavior({
  [`theme/${name}/apply`]: select({ self: $.self, theme: $.theme })
    .clause(defaultTo($.self, THEME, $.theme, null))
    .not(q => q.match($.self, THEME, refer(theme)))
    .update(({ self }) => [
      ...applyTheme(self, theme)
    ]).commit()
});

export const PrincessTheme = Themeable('princess', princessTheme);
export const ScienceTheme = Themeable('science', scienceTheme);
