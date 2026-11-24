import { Prisma } from ".prisma/tenant-client";

/**
 * Condição SQL: nesse dia, as aulas normais da turma estão suspensas por uma época de provas
 * PUBLICADA com interrupção das aulas. Usada onde o horário diz que aulas há num dia.
 * (`group` e `day` são colunas escritas no código, nunca dados de quem pede.)
 */
export const lessonsSuspended = (group: string, day: string) =>
  Prisma.raw(`EXISTS (SELECT 1 FROM exam_seasons xs_ JOIN exam_season_groups xg_ ON xg_.season_id = xs_.id
                       WHERE xg_.group_id = ${group} AND xs_.status = 'PUBLISHED' AND xs_.interrupts AND ${day} BETWEEN xs_.starts_on AND xs_.ends_on)`);
