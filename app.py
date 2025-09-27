import os
import sqlite3
import pandas as pd
from flask import Flask, render_template, request, redirect, url_for, flash
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['DATABASE'] = 'internships.db'
app.config['SECRET_KEY'] = 'a-very-secret-key'

def get_db():
    db = sqlite3.connect(app.config['DATABASE'])
    db.row_factory = sqlite3.Row
    return db

def infer_data_type(series):
    series_numeric = pd.to_numeric(series.dropna(), errors='coerce')
    if not series_numeric.empty and series_numeric.notna().all():
        if (series_numeric == series_numeric.astype(int)).all():
            return 'INTEGER'
        else:
            return 'REAL'
    return 'TEXT'

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload():
    if 'file' not in request.files:
        flash('파일이 없습니다.')
        return redirect(url_for('index'))

    file = request.files['file']
    year = request.form.get('year')

    if file.filename == '' or not year:
        flash('학년도와 파일을 모두 선택해주세요.')
        return redirect(url_for('index'))

    if file:
        filename = secure_filename(file.filename)
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], f"{year}_{filename}")
        file.save(filepath)

        try:
            df = pd.read_excel(filepath, engine='openpyxl')
            original_columns = df.columns.tolist()
            cleaned_columns = [col.replace(' ', '_').replace('.', '').replace('(', '').replace(')', '').replace('/', '') for col in original_columns]
            inferred_types = [infer_data_type(df[col]) for col in original_columns]
            sample_data = df.head().values.tolist()

            schema_info = [{'original': orig, 'cleaned': clean, 'type': dtype} for orig, clean, dtype in zip(original_columns, cleaned_columns, inferred_types)]

            return render_template('confirm_schema.html', schema=schema_info, sample_data=sample_data, year=year, filepath=filepath)
        except Exception as e:
            flash(f'파일 처리 중 오류가 발생했습니다: {e}')
            return redirect(url_for('index'))

    return redirect(url_for('index'))

@app.route('/create_db', methods=['POST'])
def create_db():
    filepath = request.form.get('filepath')
    year = request.form.get('year')

    columns = []
    i = 0
    while f'column_name_{i}' in request.form:
        columns.append({'name': request.form[f'column_name_{i}'], 'type': request.form[f'column_type_{i}']})
        i += 1

    if not all([filepath, year, columns]):
        flash('필수 정보가 누락되었습니다.')
        return redirect(url_for('index'))

    table_name = f"internships_{year}"

    try:
        db = get_db()
        cursor = db.cursor()
        cursor.execute(f"DROP TABLE IF EXISTS {table_name}")
        cols_sql = ", ".join([f'"{col["name"]}" {col["type"]}' for col in columns])
        cursor.execute(f"CREATE TABLE {table_name} ({cols_sql})")
        db.commit()
        db.close()
        return redirect(url_for('insert_data', table_name=table_name, filepath=filepath))
    except Exception as e:
        flash(f'데이터베이스 테이블 생성 중 오류 발생: {e}')
        return redirect(url_for('index'))

@app.route('/insert_data')
def insert_data():
    table_name = request.args.get('table_name')
    filepath = request.args.get('filepath')

    if not all([table_name, filepath]):
        flash('테이블 이름 또는 파일 경로가 없습니다.')
        return redirect(url_for('index'))

    try:
        db = get_db()
        cursor = db.cursor()

        cursor.execute(f"PRAGMA table_info({table_name})")
        table_info = cursor.fetchall()
        db_column_names = [col['name'] for col in table_info]
        db_column_types = {col['name']: col['type'] for col in table_info}

        df = pd.read_excel(filepath, engine='openpyxl')

        if len(df.columns) != len(db_column_names):
            flash('엑셀 파일과 DB 테이블의 컬럼 수가 일치하지 않습니다.')
            db.close()
            return redirect(url_for('index'))

        inserted_count = 0
        for index, row in df.iterrows():
            values_to_insert = []
            for i, value in enumerate(row):
                db_col_name = db_column_names[i]
                target_type = db_column_types[db_col_name]

                sanitized_value = None
                if not pd.isna(value):
                    try:
                        if target_type == 'INTEGER':
                            sanitized_value = int(float(value))
                        elif target_type == 'REAL':
                            sanitized_value = float(value)
                        else:
                            sanitized_value = str(value)
                    except (ValueError, TypeError):
                        sanitized_value = None

                values_to_insert.append(sanitized_value)

            placeholders = ", ".join(["?"] * len(db_column_names))
            sql = f'INSERT INTO {table_name} VALUES ({placeholders})'
            cursor.execute(sql, tuple(values_to_insert))
            inserted_count += 1

        db.commit()
        db.close()

        return redirect(url_for('success', table_name=table_name, count=inserted_count))

    except Exception as e:
        flash(f'데이터 삽입 중 오류가 발생했습니다: {e}')
        if 'db' in locals() and db:
            db.close()
        return redirect(url_for('index'))

@app.route('/success')
def success():
    return render_template('success.html',
                           table_name=request.args.get('table_name'),
                           count=request.args.get('count'))

if __name__ == '__main__':
    if not os.path.exists(app.config['UPLOAD_FOLDER']):
        os.makedirs(app.config['UPLOAD_FOLDER'])
    # Kill previous server if any
    os.system("kill $(lsof -t -i:5000)")
    os.system("kill $(lsof -t -i:5001)")
    app.run(debug=True, port=5001)