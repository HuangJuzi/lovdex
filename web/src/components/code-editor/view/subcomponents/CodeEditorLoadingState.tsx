import { getEditorLoadingStyles } from '../../utils/editorStyles';

type CodeEditorLoadingStateProps = {
  isSidebar: boolean;
  loadingText: string;
};

export default function CodeEditorLoadingState({
  isSidebar,
  loadingText,
}: CodeEditorLoadingStateProps) {
  return (
    <>
      <style>{getEditorLoadingStyles()}</style>
      {isSidebar ? (
        <div className="flex h-full w-full items-center justify-center bg-background">
          <div className="flex items-center gap-3">
            <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-primary" />
            <span className="text-foreground">{loadingText}</span>
          </div>
        </div>
      ) : (
        <div className="fixed inset-0 z-[9999] md:flex md:items-center md:justify-center md:bg-black/50">
          <div className="code-editor-loading flex h-full w-full items-center justify-center p-8 md:h-auto md:w-auto md:rounded-lg">
            <div className="flex items-center gap-3">
              <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-primary" />
              <span className="text-foreground">{loadingText}</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
