/**
 * DetailUnavailable — the labelled state for "this title's details could not be read".
 *
 * Shares the cause / what-to-do / where-to-go grammar with the catalog, not-found and error
 * states through the shared StateRegion, so a reader meets the same shape wherever the product
 * has to admit something. The wording is deliberately about the reader's situation — the title
 * is not gone and their place in it is intact — and says nothing about the upstream status.
 */
import { StateRegion } from '../../../shared/ui/StateRegion';

export type DetailUnavailableProps = {
  /** Id of the heading that names this region. */
  labelledBy: string;
  retryHref: string;
};

export function DetailUnavailable({ labelledBy, retryHref }: DetailUnavailableProps) {
  return (
    <StateRegion
      headingId={labelledBy}
      headingLevel={1}
      title="This title could not be loaded"
      cause="The details could not be read just now. The title has not been removed, and your place in it is untouched."
      remedy="Try again in a moment, or go back to the catalog and find the title again."
      actions={[
        { href: retryHref, label: 'Try again', primary: true },
        { href: '/discover', label: 'Back to the catalog' },
      ]}
    />
  );
}

export default DetailUnavailable;
