export interface CriminalAssessmentArticle {
  code: string;
  title: string;
}

export interface CriminalAssessment {
  probability: number;
  articles: CriminalAssessmentArticle[];
  reason: string;
}

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DeepSeekOptions {
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
}
