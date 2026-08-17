import React from 'react';
import { Markdown } from '../../../view/subcomponents/Markdown';

interface MarkdownContentProps {
  content: string;
  className?: string;
  onFileOpen?: (filePath: string, line?: number) => void;
}

/**
 * Renders markdown content with proper styling
 * Used by: exit_plan_mode, long text results, etc.
 */
export const MarkdownContent: React.FC<MarkdownContentProps> = ({
  content,
  className = 'mt-1 prose prose-sm max-w-none dark:prose-invert',
  onFileOpen,
}) => {
  return (
    <Markdown className={className} onFileOpen={onFileOpen}>
      {content}
    </Markdown>
  );
};
