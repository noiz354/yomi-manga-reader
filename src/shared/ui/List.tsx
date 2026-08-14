/**
 * List — real list semantics for every collection in the product.
 *
 * Chapter lists and the catalog grid must be real `ul`/`ol` with `li`; a grid of
 * `div`s reads as an unlabelled blob of links to a screen reader. This primitive
 * makes the correct element the default and the exception the deliberate choice.
 */

// TODO: row content, read indicators and cursor pagination belong to the features.
import type { HTMLAttributes, LiHTMLAttributes, ReactNode } from 'react';

export type ItemListProps = HTMLAttributes<HTMLUListElement | HTMLOListElement> & {
  /** `ol` when order carries meaning (reading order, chapter number). */
  as?: 'ul' | 'ol';
  /** Names the list for assistive tech when the surrounding heading is not
   *  close enough to be the obvious name. */
  label?: string;
  children: ReactNode;
};

export function ItemList({ as = 'ul', label, className, children, ...rest }: ItemListProps) {
  const classes = ['list'];
  if (className) classes.push(className);
  // `as` is a union of the two elements, so the spread needs a type both
  // accept. The cast is the price of one component covering both, and it is
  // contained on this line.
  const Element = as;
  return (
    <Element className={classes.join(' ')} aria-label={label} {...rest}>
      {children}
    </Element>
  );
}

export type ItemListItemProps = LiHTMLAttributes<HTMLLIElement> & { children: ReactNode };

/** The row. Always an `li`, so the list's structure cannot be broken. */
export function ItemListItem({ className, children, ...rest }: ItemListItemProps) {
  const classes = ['list__item'];
  if (className) classes.push(className);
  return (
    <li className={classes.join(' ')} {...rest}>
      {children}
    </li>
  );
}

export default ItemList;
