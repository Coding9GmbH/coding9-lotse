/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ResolveInfo } from '../graphql';
import { type ConnArgs, type Ctx, idOf, metafieldResolvers, paginate, safeIdOf, search, sortBy, stripHtml, truncate, ue, type UE } from '../context';
import type { SearchSpec } from '../search';
import { gid, handleize, isoNow, type PageRec } from '../state';
import { ownerMetafieldInputs, setMetafields } from './metafields';
import { addRedirect } from './products';
import { translationsFor } from './translations';

const pageSearchSpec: SearchSpec<PageRec> = {
  fields: {
    title: { kind: 'text', get: (p) => p.title },
    handle: { kind: 'keyword', get: (p) => p.handle },
    id: { kind: 'number', get: (p) => p.id },
    created_at: { kind: 'date', get: (p) => p.createdAt },
    updated_at: { kind: 'date', get: (p) => p.updatedAt },
    published_at: { kind: 'date', get: (p) => p.publishedAt },
    published_status: { kind: 'keyword', get: (p) => ['any', p.isPublished ? 'published' : 'unpublished'] },
  },
  freeText: (p) => [p.title, p.handle, stripHtml(p.body)],
};

function sortPages(list: PageRec[], sortKey?: string | null): PageRec[] {
  if (sortKey === 'TITLE') return sortBy(list, (p) => p.title, (p) => p.id);
  if (sortKey === 'UPDATED_AT') return sortBy(list, (p) => p.updatedAt, (p) => p.id);
  if (sortKey === 'PUBLISHED_AT') return sortBy(list, (p) => p.publishedAt ?? '', (p) => p.id);
  return sortBy(list, (p) => p.id, (p) => p.id);
}

export const pageTypes = {
  Page: {
    id: (p: PageRec) => gid('Page', p.id),
    bodySummary: (p: PageRec) => truncate(stripHtml(p.body), 150),
    isPublished: (p: PageRec) => p.isPublished && (!p.publishedAt || Date.parse(p.publishedAt) <= Date.now()),
    ...metafieldResolvers((p: PageRec) => gid('Page', p.id)),
    translations: (p: PageRec, a: { locale: string; marketId?: string | null }, ctx: Ctx) => translationsFor(gid('Page', p.id), a.locale, ctx, a.marketId),
  },
};

export const pageQueries = {
  pages: (_: unknown, a: ConnArgs & { query?: string; sortKey?: string }, ctx: Ctx, info: ResolveInfo) => {
    const list = search(sortPages([...ctx.state.pages.values()], a.sortKey), a.query, pageSearchSpec, ctx, info);
    return paginate(list, a, ctx, (p) => p.id);
  },
  page: (_: unknown, a: { id: string }, ctx: Ctx) => {
    const id = idOf(a.id, 'Page');
    return id !== null ? (ctx.state.pages.get(id) ?? null) : null;
  },
  pagesCount: (_: unknown, a: { limit?: number }, ctx: Ctx) => {
    const n = ctx.state.pages.size;
    const limit = a.limit ?? 10000;
    return { count: Math.min(n, limit), precision: n > limit ? 'AT_LEAST' : 'EXACT' };
  },
};

function validatePublishDate(v: unknown, errors: UE[]): void {
  if (v != null && Number.isNaN(Date.parse(String(v)))) errors.push(ue(['page', 'publishDate'], 'Publish date is invalid', 'INVALID_PUBLISH_DATE'));
}

export const pageMutations = {
  pageCreate: (_: unknown, a: { page: any }, ctx: Ctx) => {
    const input = a.page;
    const errors: UE[] = [];
    if (!String(input.title ?? '').trim()) errors.push(ue(['page', 'title'], "Title can't be blank", 'BLANK'));
    if (String(input.title ?? '').length > 255) errors.push(ue(['page', 'title'], 'Title is too long (maximum is 255 characters)', 'TOO_LONG'));
    let handle: string | null = null;
    if (input.handle) {
      handle = handleize(input.handle);
      if (!handle) errors.push(ue(['page', 'handle'], 'Handle is invalid', 'INVALID'));
      else if (ctx.state.handleTaken('page', handle)) errors.push(ue(['page', 'handle'], 'Handle has already been taken', 'TAKEN'));
    }
    validatePublishDate(input.publishDate, errors);
    if (errors.length) return { page: null, userErrors: errors };
    const now = isoNow();
    const scheduled = input.publishDate && Date.parse(input.publishDate) > Date.now();
    const isPublished = input.isPublished ?? true;
    const page: PageRec = {
      id: ctx.state.nextId('Page'),
      title: input.title,
      handle: handle ?? ctx.state.uniqueHandle('page', handleize(input.title) || 'page'),
      body: input.body ?? '',
      isPublished: Boolean(isPublished || scheduled),
      publishedAt: input.publishDate ? new Date(input.publishDate).toISOString().replace(/\.\d{3}Z$/, 'Z') : isPublished ? now : null,
      templateSuffix: input.templateSuffix || null,
      createdAt: now,
      updatedAt: now,
    };
    ctx.state.pages.set(page.id, page);
    if (input.metafields?.length) {
      const res = setMetafields(ownerMetafieldInputs(gid('Page', page.id), input.metafields), ctx, (i, n) => ['page', 'metafields', i, n]);
      if (res.errors.length) {
        ctx.state.pages.delete(page.id);
        return { page: null, userErrors: res.errors.map((e) => ({ ...e, code: 'INVALID' })) };
      }
    }
    return { page, userErrors: [] };
  },

  pageUpdate: (_: unknown, a: { id: string; page: any }, ctx: Ctx) => {
    const id = safeIdOf(a.id, 'Page');
    const page = id !== null ? ctx.state.pages.get(id) : undefined;
    if (!page) return { page: null, userErrors: [ue(['id'], 'Page does not exist', 'NOT_FOUND')] };
    const input = a.page;
    const errors: UE[] = [];
    if (input.title !== undefined && !String(input.title ?? '').trim()) errors.push(ue(['page', 'title'], "Title can't be blank", 'BLANK'));
    if (input.title && String(input.title).length > 255) errors.push(ue(['page', 'title'], 'Title is too long (maximum is 255 characters)', 'TOO_LONG'));
    let handle: string | null = null;
    if (input.handle !== undefined && input.handle !== null) {
      handle = handleize(input.handle);
      if (!handle) errors.push(ue(['page', 'handle'], "Handle can't be blank", 'BLANK'));
      else if (ctx.state.handleTaken('page', handle, page.id)) errors.push(ue(['page', 'handle'], 'Handle has already been taken', 'TAKEN'));
    }
    validatePublishDate(input.publishDate, errors);
    if (input.metafields?.length) {
      errors.push(...setMetafields(ownerMetafieldInputs(gid('Page', page.id), input.metafields), ctx, (i, n) => ['page', 'metafields', i, n], { dryRun: true }).errors.map((e) => ({ ...e, code: 'INVALID' })));
    }
    if (errors.length) return { page, userErrors: errors };
    const now = isoNow();
    if (input.title !== undefined) page.title = input.title;
    if (handle && handle !== page.handle) {
      if (input.redirectNewHandle) addRedirect(`/pages/${page.handle}`, `/pages/${handle}`, ctx);
      page.handle = handle;
    }
    if (input.body !== undefined) page.body = input.body ?? '';
    if (input.templateSuffix !== undefined) page.templateSuffix = input.templateSuffix || null;
    if (input.publishDate !== undefined) {
      page.publishedAt = input.publishDate ? new Date(input.publishDate).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
      page.isPublished = Boolean(input.publishDate);
    }
    if (input.isPublished !== undefined && input.isPublished !== null) {
      page.isPublished = input.isPublished;
      page.publishedAt = input.isPublished ? (page.publishedAt ?? now) : null;
    }
    if (input.metafields?.length) setMetafields(ownerMetafieldInputs(gid('Page', page.id), input.metafields), ctx, (i, n) => ['page', 'metafields', i, n]);
    page.updatedAt = now;
    return { page, userErrors: [] };
  },

  pageDelete: (_: unknown, a: { id: string }, ctx: Ctx) => {
    const id = safeIdOf(a.id, 'Page');
    const page = id !== null ? ctx.state.pages.get(id) : undefined;
    if (!page) return { deletedPageId: null, userErrors: [ue(['id'], 'Page does not exist', 'NOT_FOUND')] };
    ctx.state.pages.delete(page.id);
    ctx.state.deleteOwnerData(gid('Page', page.id));
    return { deletedPageId: gid('Page', page.id), userErrors: [] };
  },
};
