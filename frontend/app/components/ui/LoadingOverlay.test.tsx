import { render, screen } from '@testing-library/react';
import { LoadingOverlay } from './LoadingOverlay';
import { describe, it, expect } from 'vitest';

describe('LoadingOverlay', () => {
  it('renders the loading spinner', () => {
    const { container } = render(<LoadingOverlay />);
    expect(container.querySelector('.spinner-doodle')).toBeInTheDocument();
  });

  it('does not render text when text prop is not provided', () => {
    const { container } = render(<LoadingOverlay />);
    expect(container.querySelector('p')).not.toBeInTheDocument();
  });

  it('renders custom text when provided', () => {
    render(<LoadingOverlay text="Generating..." />);
    const textElement = screen.getByText('Generating...');
    expect(textElement).toBeInTheDocument();
    expect(textElement.tagName).toBe('P');
  });

  it('applies custom className', () => {
    const { container } = render(<LoadingOverlay className="my-custom-class" />);
    expect(container.firstChild).toHaveClass('my-custom-class');
  });
});
