import { render, screen } from '@testing-library/react';
import { Card } from './Card';
import { describe, it, expect } from 'vitest';

describe('Card', () => {
  it('renders children correctly', () => {
    render(<Card>Card Content</Card>);
    expect(screen.getByText('Card Content')).toBeInTheDocument();
  });

  it('renders with a string title', () => {
    render(<Card title="My Title">Card Content</Card>);
    expect(screen.getByRole('heading', { name: /my title/i, level: 3 })).toBeInTheDocument();
  });

  it('renders with a ReactNode title', () => {
    render(<Card title={<span>Custom Title</span>}>Card Content</Card>);
    expect(screen.getByText('Custom Title')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3 })).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(<Card className="my-custom-class">Content</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card).toHaveClass('my-custom-class');
    expect(card).toHaveClass('card-doodle');
  });

  it('applies custom style', () => {
    const { container } = render(<Card style={{ color: 'red', backgroundColor: 'blue' }}>Content</Card>);
    const card = container.firstChild as HTMLElement;
    // 验证调用方的内联样式原样应用。
    expect(card.style.color).toBe('red');
    expect(card.style.backgroundColor).toBe('blue');
  });

  it('applies variant styles', () => {
    const { container, rerender } = render(<Card variant="primary">Primary</Card>);
    let card = container.firstChild as HTMLElement;
    expect(card).toHaveClass('bg-primary/10');
    expect(card).toHaveClass('border-primary');

    rerender(<Card variant="secondary">Secondary</Card>);
    card = container.firstChild as HTMLElement;
    expect(card).toHaveClass('bg-secondary/10');
    expect(card).toHaveClass('border-secondary');
  });

  it('uses default variant when none is provided', () => {
    const { container } = render(<Card>Default</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card).toHaveClass('bg-paper-100');
  });
});
