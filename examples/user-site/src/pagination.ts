import { useState } from "react";

interface PaginatedListOptions<T> {
  items?: readonly T[];
  pages?: readonly (readonly T[])[];
  pageSize: number;
  scope: string;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  loadMore?: (() => Promise<unknown>) | undefined;
}

interface PaginationState {
  scope: string;
  page: number;
}

/** Keeps long cursor-backed lists bounded without discarding already loaded pages. */
export function usePaginatedList<T>({
  items = [],
  pages,
  pageSize,
  scope,
  hasMore = false,
  isLoadingMore = false,
  loadMore,
}: PaginatedListOptions<T>) {
  const [state, setState] = useState<PaginationState>({ scope, page: 0 });
  const chunks = (pages ?? [items]).flatMap((source) =>
    Array.from({ length: Math.ceil(source.length / pageSize) }, (_, index) =>
      source.slice(index * pageSize, (index + 1) * pageSize),
    ),
  );
  const requestedPage = state.scope === scope ? state.page : 0;
  const lastLoadedPage = Math.max(0, chunks.length - 1);
  const page = Math.min(requestedPage, lastLoadedPage);
  const pageItems = chunks[page] ?? [];
  const hasPrevious = page > 0;
  const hasNext = page + 1 < chunks.length || hasMore;

  const previous = () => {
    setState({ scope, page: Math.max(0, page - 1) });
  };
  const next = async () => {
    if (!hasNext || isLoadingMore) return;
    if (page + 1 >= chunks.length && hasMore && loadMore) await loadMore();
    setState({ scope, page: page + 1 });
  };

  return {
    items: pageItems,
    page,
    hasPrevious,
    hasNext,
    isLoading: isLoadingMore,
    previous,
    next,
  };
}
