'use client';
import { StateRegion } from '../shared/ui/StateRegion';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <StateRegion
      headingId="error-title"
      headingLevel={1}
      title="Something went wrong"
      cause="This page could not be shown. Nothing was changed, and it is not something you did."
      remedy="Try again — that often works. If it does not, the reader may be temporarily unavailable and the catalog is the safer place to be."
      // A reset, not a link to this same address: the segment is re-rendered in place rather
      // than fetched again, which is why this state cannot use the shared link action.
      onRetry={{ label: 'Try again', onClick: reset }}
      actions={[{ href: '/', label: 'Go to the home page' }]}
    >
      {error.digest === undefined ? null : (
        <p className="note">
          Reference for the operator: <span className="num">{error.digest}</span>
        </p>
      )}
    </StateRegion>
  );
}
