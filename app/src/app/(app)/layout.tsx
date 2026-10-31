import { createHash } from 'node:crypto';
import { AppShell } from '@/components/app-shell';
import { requireSession } from '@/server/auth/session';
import { listBrandOptions } from '@/server/db/brands';
import { getPool } from '@/server/db/pool';
import { listTemplates } from '@/server/db/templates';
import { loadMailPending, loadSettings, loadStages, loadViews } from '@/server/queries';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  // who is signed in, as an opaque tag (not the account id itself): unsaved input carried across a sign-in is
  // offered back to the same owner only
  const owner = createHash('sha256').update(`review-workflow:recovery-owner:${session.mode}:${session.subject}`).digest('base64url').slice(0, 22);
  const db = getPool();
  const [stages, templates, brands, settings, views, mailPending] = await Promise.all([
    loadStages(),
    listTemplates(db),
    listBrandOptions(db),
    loadSettings(),
    loadViews(),
    loadMailPending(),
  ]);
  return (
    <AppShell
      stages={stages}
      templates={templates.map(({ bodyMd: _body, checklist: _checklist, ...t }) => t)}
      brands={brands}
      settings={settings}
      views={views.map(({ id, layout, name, position, version }) => ({ id, layout, name, position, version }))}
      mailPending={mailPending}
      owner={owner}
    >
      {children}
    </AppShell>
  );
}
