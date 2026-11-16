// Speech rules written by the earlier standalone installer (v1) relied on
// report handling that was built into the code then. A rules file from that
// installer (it has table-label rules or a _team._default, and no _report)
// gets those settings back here, so an existing setup keeps sounding the same.
// New setups never see this: the plugin's own defaults are plain.
export const V1_RULES = {
  _marks: { '❓': 'question', '\u{1F6D1}': 'blocked', '\u{1F4CB}': 'info' },
  _report: {
    ask: 'Tőled',
    nothing: 'semmi',
    approval: 'jóváhagy',
    done: '\\bMerged\\b|beolvadt',
    pr: 'PR',
    order: { 'Kész': 1, 'Fut': 3, 'PR': 2, 'Tőled': 0 },
  },
  _ignoreSenders: '^háttérügynök\\b',
  _fullMark: 'felolvas:\\s*teljes',
  _fullForUserTurns: true,
};

export function isV1Rules(user) {
  if (!user || typeof user !== 'object' || user._report) return false;
  return Object.keys(user).some((k) => !k.startsWith('_')) || !!user._team?._default;
}
