// The outline's group headings: consecutive sections whose schema names the
// same `group` share one heading (Signals · Reference · X axis PV · …).

import type { OutlineSection } from './types';

export interface GroupView {
  title: string;
  sections: OutlineSection[];
}

/** Consecutive sections whose kinds name the same group, under that group's title. */
export function outlineGroups(
  sectionGroup: (kind: string) => string | undefined,
  sections: readonly OutlineSection[]
): GroupView[] {
  const groups: GroupView[] = [];
  for (const section of sections) {
    const title = sectionGroup(section.kind) ?? section.title;
    const last = groups[groups.length - 1];
    if (last !== undefined && last.title === title) last.sections.push(section);
    else groups.push({ title, sections: [section] });
  }
  return groups;
}
