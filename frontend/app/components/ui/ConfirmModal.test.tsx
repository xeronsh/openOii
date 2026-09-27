import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmModal } from './ConfirmModal';
import { describe, it, expect, vi } from 'vitest';

describe('ConfirmModal', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    message: 'Are you sure?',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not render when isOpen is false', () => {
    render(<ConfirmModal {...defaultProps} isOpen={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders correctly when isOpen is true', () => {
    render(<ConfirmModal {...defaultProps} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('确认操作')).toBeInTheDocument(); // default title
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认' })).toBeInTheDocument(); // default confirmText
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument(); // default cancelText
  });

  it('displays custom title, message, and button texts', () => {
    render(
      <ConfirmModal
        {...defaultProps}
        title="Delete Item"
        message="This action cannot be undone."
        confirmText="Delete"
        cancelText="Keep"
      />
    );
    expect(screen.getByText('Delete Item')).toBeInTheDocument();
    expect(screen.getByText('This action cannot be undone.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep' })).toBeInTheDocument();
  });

  it('calls onConfirm when confirm button is clicked', async () => {
    const user = userEvent.setup();
    render(<ConfirmModal {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: '确认' }));
    expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when cancel button is clicked', async () => {
    const user = userEvent.setup();
    render(<ConfirmModal {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', async () => {
    const user = userEvent.setup();
    render(<ConfirmModal {...defaultProps} />);

    await user.click(screen.getByRole('dialog').parentElement!);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows loading state and disables buttons', async () => {
    const user = userEvent.setup();
    render(<ConfirmModal {...defaultProps} isLoading={true} />);
    
    const confirmButton = screen.getByRole('button', { name: '确认' });
    const cancelButton = screen.getByRole('button', { name: '取消' });

    expect(confirmButton).toBeDisabled();
    expect(cancelButton).toBeDisabled();
    expect(confirmButton.querySelector('.spinner-doodle')).toBeInTheDocument();

    await user.click(confirmButton);
    await user.click(cancelButton);

    expect(defaultProps.onConfirm).not.toHaveBeenCalled();
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });

  it('applies variant styles', () => {
    const { rerender } = render(<ConfirmModal {...defaultProps} variant="warning" />);
    expect(screen.getByRole('button', { name: '确认' })).toHaveClass('bg-warning');

    rerender(<ConfirmModal {...defaultProps} variant="info" />);
    expect(screen.getByRole('button', { name: '确认' })).toHaveClass('bg-info');
    
    rerender(<ConfirmModal {...defaultProps} variant="danger" />);
    expect(screen.getByRole('button', { name: '确认' })).toHaveClass('bg-error');
  });
});
