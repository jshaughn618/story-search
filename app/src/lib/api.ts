import type {
  DeleteStoryResponse,
  FiltersResponse,
  SearchRequest,
  SearchResponse,
  StoryDetailResponse,
  StoryUpdateRequest,
  StoryUpdateResponse,
} from "../types";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let errorText = `Request failed with ${response.status}`;
    try {
      const data = (await response.json()) as { error?: string };
      if (data.error) {
        errorText = data.error;
      }
    } catch {
      // noop
    }
    throw new ApiError(errorText, response.status);
  }

  return (await response.json()) as T;
}

export function fetchFilters() {
  return apiRequest<FiltersResponse>("/api/filters");
}

export function searchStories(body: SearchRequest) {
  return apiRequest<SearchResponse>("/api/search", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function fetchStory(storyId: string, chunk?: number | null) {
  const params = new URLSearchParams();
  if (typeof chunk === "number") {
    params.set("chunk", String(chunk));
  }

  const query = params.toString();
  const path = query ? `/api/story/${storyId}?${query}` : `/api/story/${storyId}`;
  return apiRequest<StoryDetailResponse>(path);
}

export function deleteStory(storyId: string) {
  return apiRequest<DeleteStoryResponse>(`/api/story/${storyId}`, {
    method: "DELETE",
  });
}

export function updateStory(storyId: string, body: StoryUpdateRequest) {
  return apiRequest<StoryUpdateResponse>(`/api/story/${storyId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}
