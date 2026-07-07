import styles from './ui.module.css'

export function Button({ children, variant = 'default', size = 'md', disabled, onClick, className = '', ...props }) {
  return (
    <button
      className={[styles.btn, styles[`btn_${variant}`], styles[`btn_${size}`], className].join(' ')}
      disabled={disabled}
      onClick={onClick}
      {...props}
    >
      {children}
    </button>
  )
}

export function MethodBadge({ method }) {
  return <span className={[styles.method, styles[`method_${method}`]].join(' ')}>{method}</span>
}

export function Modal({ open, onClose, title, children, maxWidth }) {
  if (!open) return null
  // 배경 클릭으로 닫히지 않음 — 버튼(X/취소/확인 등)으로만 닫기
  return (
    <div className={styles.overlay}>
      <div className={styles.modal} style={maxWidth ? { maxWidth } : {}}>
        <div className={styles.modal_head}>
          <div className={styles.modal_title}>{title}</div>
          <button className={styles.modal_close} onClick={onClose}>x</button>
        </div>
        <div className={styles.modal_body}>
          {children}
        </div>
      </div>
    </div>
  )
}

export function BottomSheet({ open, onClose, title, children }) {
  if (!open) return null
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.sheet} onClick={e => e.stopPropagation()}>
        <div className={styles.modal_head}>
          <div className={styles.modal_title}>{title}</div>
          <button className={styles.modal_close} onClick={onClose}>x</button>
        </div>
        <div className={styles.modal_body}>
          {children}
        </div>
      </div>
    </div>
  )
}

export function FormGroup({ label, children }) {
  return (
    <div className={styles.form_group}>
      <label className={styles.form_label}>{label}</label>
      {children}
    </div>
  )
}

export function Input({ ...props }) {
  return <input className={styles.input} {...props} />
}

export function Toast({ message, visible }) {
  return <div className={[styles.toast, visible ? styles.toast_show : ''].join(' ')}>{message}</div>
}
