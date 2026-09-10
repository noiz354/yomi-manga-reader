/**
 * Settings (`/settings`) route shell — authenticated.
 * Behavior: reader preferences form (defaultMode, directionOverride,
 * zoomDefault, autoNextChannel — labeled fields); account section (password
 * change, delete account with confirm). No feature code in this phase.
 * The preference form is where the fieldset/legend pattern applies — radio
 * groups for mode, direction and channel — which the FormField primitive does
 * not yet cover.
 */
import type { Metadata } from 'next';
import { NotYetBuilt } from '../../shared/ui/StateRegion';

export const metadata: Metadata = {
  title: 'Settings',
};

export default function SettingsPage() {
  return (
    <>
      <h1>Settings</h1>
      <NotYetBuilt
        headingId="settings-not-built"
        intent="edit your reader preferences and account details"
        actions={[{ href: '/discover', label: 'Browse the catalog', primary: true }]}
      />
      {/* TODO: reader preferences form */}
      {/* TODO: account section (password, delete) */}
    </>
  );
}
