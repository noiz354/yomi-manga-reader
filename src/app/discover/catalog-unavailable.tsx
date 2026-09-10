/**
 * CatalogUnavailable — the labelled state for "the catalog could not be read".
 *
 * A page that cannot reach its own API is not a crash: the shell, the nav and
 * the h1 are all still true, and a reader who reloads may well get the shelf.
 * So the read failure is a value and this is what it renders.
 *
 * The retry is a link, not a button: the target is the page's OWN address, so
 * it works with scripting off, is announced as navigation, and middle-click and
 * open-in-new-tab behave as expected.
 *
 * What the reader is told is bounded on purpose — "the catalog is temporarily
 * unavailable" — while the upstream status, the request id and any storage
 * detail stay on the server: a catalog 500 tells an attacker nothing useful and
 * a reader nothing actionable.
 */
import { StateRegion } from '../../shared/ui/StateRegion';

export type CatalogUnavailableProps = {
  /** Id of the heading that names this region. */
  labelledBy: string;
  /** The page's own address: the honest retry target. */
  retryHref: string;
};

export function CatalogUnavailable({ labelledBy, retryHref }: CatalogUnavailableProps) {
  return (
    <StateRegion
      headingId={labelledBy}
      title="The catalog is unavailable"
      cause="The list of titles could not be read just now. Nothing has been removed, and the library itself is not lost."
      remedy="Try again in a moment. A title you were reading is still reachable by its address."
      actions={[
        { href: retryHref, label: 'Try again', primary: true },
        { href: '/', label: 'Go to the home page' },
      ]}
    />
  );
}

export default CatalogUnavailable;
