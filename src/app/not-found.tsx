import { StateRegion } from '../shared/ui/StateRegion';

export const metadata = {
  title: 'Page not found',
};

export default function NotFound() {
  return (
    <StateRegion
      headingId="not-found-title"
      headingLevel={1}
      title="Page not found"
      cause="There is nothing at this address. The link that brought you here may be out of date, or the page may have moved."
      remedy="Browse the catalog for something to read, or start over from the home page."
      actions={[
        { href: '/discover', label: 'Go to the catalog', primary: true },
        { href: '/', label: 'Go to the home page' },
      ]}
      // TODO: a manga or chapter that is unpublished, deleted or
      // unavailable reuses this page — the wording must not distinguish those cases from an
      // unknown route.
    />
  );
}
