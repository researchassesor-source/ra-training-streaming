function setupQuestions(room, options = {}) {
  const container = document.getElementById('questionMessages');
  const sortSelect = document.getElementById('questionSort');
  const moderator = ['ADMIN', 'ORGANIZER', 'PANELIST'].includes(options.role);
  let items = [];
  let reloadTimer = null;
  let disposed = false;

  const statusLabels = {
    PENDING: 'Pendiente',
    ANSWERED_LIVE: 'Respondida en vivo',
    ANSWERED_WRITTEN: 'Respondida por escrito',
    DISMISSED: 'Descartada',
  };

  function button(label, action, className = 'secondary compact') {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = label;
    element.onclick = async () => {
      element.disabled = true;
      try { await action(); } catch (error) { options.onError?.(error.message); } finally { element.disabled = false; }
    };
    return element;
  }

  async function update(id, body) {
    const result = await roomRequest(`/api/questions/${encodeURIComponent(id)}`, { method: 'PATCH', body }, options.csrfToken);
    items = items.map((item) => item.id === id ? result.question : item);
    render();
  }

  function writtenAnswer(item, host) {
    const form = document.createElement('form');
    form.className = 'question-answer-form';
    form.hidden = true;
    const input = document.createElement('textarea');
    input.rows = 2;
    input.maxLength = 1200;
    input.placeholder = 'Escribe una respuesta visible para todos…';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'primary compact';
    submit.textContent = 'Publicar respuesta';
    form.append(input, submit);
    form.onsubmit = async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try { await update(item.id, { answer: input.value }); } catch (error) { options.onError?.(error.message); } finally { submit.disabled = false; }
    };
    host.appendChild(form);
    return form;
  }

  function render() {
    if (disposed) return;
    container.replaceChildren();
    const visible = items
      .filter((item) => moderator || item.status !== 'DISMISSED')
      .sort((a, b) => sortSelect?.value === 'date'
        ? String(b.createdAt).localeCompare(String(a.createdAt))
        : Number(b.pinned) - Number(a.pinned) || b.voteCount - a.voteCount || String(a.createdAt).localeCompare(String(b.createdAt)));
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state compact';
      empty.textContent = 'Todavía no hay preguntas. Usa el selector del campo de mensaje para enviar una.';
      container.appendChild(empty);
    }
    for (const item of visible) {
      const card = document.createElement('article');
      card.className = `question-card status-${item.status.toLowerCase()}`;
      if (item.pinned) card.classList.add('pinned');
      const meta = document.createElement('div');
      meta.className = 'question-meta';
      const author = document.createElement('strong');
      author.textContent = `${item.pinned ? 'Destacada · ' : ''}${item.authorName}`;
      const status = document.createElement('span');
      status.textContent = `${statusLabels[item.status] || item.status} · ${new Date(item.createdAt).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })}`;
      meta.append(author, status);
      const text = document.createElement('p');
      text.className = 'question-text';
      text.textContent = item.text;
      card.append(meta, text);
      if (item.answer) {
        const answer = document.createElement('div');
        answer.className = 'question-answer';
        const answerLabel = document.createElement('strong');
        answerLabel.textContent = `Respuesta${item.answeredBy ? ` de ${item.answeredBy}` : ''}`;
        const answerText = document.createElement('p');
        answerText.textContent = item.answer;
        answer.append(answerLabel, answerText);
        card.appendChild(answer);
      }
      const actions = document.createElement('div');
      actions.className = 'question-actions';
      actions.appendChild(button(`${item.voted ? 'Quitar voto' : 'Votar'} · ${item.voteCount}`, async () => {
        const result = await roomRequest(`/api/questions/${encodeURIComponent(item.id)}/vote`, { method: 'POST', body: {} }, options.csrfToken);
        items = items.map((entry) => entry.id === item.id ? result.question : entry);
        render();
      }, item.voted ? 'primary compact' : 'secondary compact'));
      if (item.isOwn && item.status === 'PENDING') {
        actions.appendChild(button('Editar', async () => {
          const edit = document.createElement('textarea');
          edit.maxLength = 600;
          edit.value = item.text;
          edit.className = 'question-inline-edit';
          text.replaceWith(edit);
          edit.focus();
          const save = button('Guardar', () => update(item.id, { text: edit.value }), 'primary compact');
          actions.replaceChildren(save, button('Cancelar', render));
        }));
        actions.appendChild(button('Eliminar', async () => {
          await roomRequest(`/api/questions/${encodeURIComponent(item.id)}`, { method: 'DELETE' }, options.csrfToken);
          items = items.filter((entry) => entry.id !== item.id);
          render();
        }, 'danger compact'));
      }
      if (moderator) {
        const answerForm = writtenAnswer(item, card);
        actions.append(
          button(item.pinned ? 'Quitar destacado' : 'Destacar', () => update(item.id, { pinned: !item.pinned })),
          button('Responder en vivo', () => update(item.id, { status: 'ANSWERED_LIVE' }), 'primary compact'),
          button('Responder por escrito', () => { answerForm.hidden = !answerForm.hidden; if (!answerForm.hidden) answerForm.querySelector('textarea').focus(); }),
          button('Descartar', () => update(item.id, { status: 'DISMISSED' }), 'danger compact'),
        );
      }
      card.appendChild(actions);
      container.appendChild(card);
    }
    const pending = items.filter((item) => item.status === 'PENDING').length;
    options.onChange?.({ items: [...items], pending });
  }

  async function reload({ notify = false } = {}) {
    const previous = new Map(items.map((item) => [item.id, item]));
    const result = await roomRequest('/api/questions');
    items = result.questions || [];
    render();
    if (notify && items.some((item) => !previous.has(item.id))) options.onNewQuestion?.();
    const answered = items.find((item) => item.isOwn && item.status.startsWith('ANSWERED') && previous.get(item.id)?.status === 'PENDING');
    if (answered) options.onAnswered?.(answered);
  }

  async function submit(text) {
    const result = await roomRequest('/api/questions', { method: 'POST', body: { text } }, options.csrfToken);
    items = [result.question, ...items.filter((item) => item.id !== result.question.id)];
    render();
    return result.question;
  }

  function onData(payload) {
    try {
      const message = JSON.parse(new TextDecoder().decode(payload));
      if (!['question-changed', 'question-deleted'].includes(message.kind)) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => reload({ notify: message.kind === 'question-changed' }).catch((error) => options.onError?.(error.message)), 120);
    } catch { /* Ignore unrelated binary packets. */ }
  }

  room.on(LivekitClient.RoomEvent.DataReceived, onData);
  sortSelect?.addEventListener('change', render);
  reload().catch((error) => options.onError?.(error.message));
  return {
    submit,
    reload,
    dispose() {
      disposed = true;
      clearTimeout(reloadTimer);
      room.off(LivekitClient.RoomEvent.DataReceived, onData);
      sortSelect?.removeEventListener('change', render);
    },
  };
}
