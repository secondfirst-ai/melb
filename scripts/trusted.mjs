import { readFileSync } from 'node:fs';

// 成员 PR 才花钱核对、才自动合并。author_association 认不出不公开的组织成员，再看 main 上的账号名单。
const { logins } = JSON.parse(readFileSync(new URL('./trusted.json', import.meta.url), 'utf8'));
export function trustedAuthor(association, login) {
  return ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association) || logins.includes(login);
}
